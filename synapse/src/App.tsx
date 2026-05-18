import { useState, useEffect, useRef } from 'react';
import { socket } from './socket';
import { ChatDisplay } from './components/ChatDisplay';
import type { Message } from './components/ChatDisplay';
import { InputBar } from './components/InputBar';
import { EntryScreen } from './components/EntryScreen';
import { ParticleBackground } from './components/ParticleBackground';
import { ModelIndicator } from './components/ModelIndicator';
import { PlanPanel, type Plan } from './components/PlanPanel';
import type { StepStatus } from './components/StepStatusIcon';

type StepStateMap = Record<number, { status: StepStatus; message?: string }>;
type RequestEvent = { request_id?: string };

const createRequestId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

function App() {
  const [showEntryScreen, setShowEntryScreen] = useState(true);
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [stepStatuses, setStepStatuses] = useState<StepStateMap>({});
  const activeRequestIdRef = useRef<string | null>(null);
  const streamMessageIdRef = useRef<string | null>(null);

  const handleSendMessage = (message: string) => {
    if (message.trim() === '') return;
    const requestId = createRequestId();
    activeRequestIdRef.current = requestId;
    streamMessageIdRef.current = null;
    socket.emit('execute_natural_command', { command: message, request_id: requestId });
    setMessages((prev) => [
      ...prev,
      { id: `user-${requestId}`, text: message, user: 'You' },
    ]);
    setIsTyping(true);
    setPlan(null);
    setStepStatuses({});
  };

  useEffect(() => {
    const isCurrentRequest = (data: RequestEvent) => (
      !data.request_id || data.request_id === activeRequestIdRef.current
    );
    const onConnect = () => setIsConnected(true);
    const onDisconnect = () => setIsConnected(false);
    const onCommandOutput = (data: { data: string } & RequestEvent) => {
      if (!isCurrentRequest(data)) return;
      setIsTyping(false);
      const streamMessageId = streamMessageIdRef.current;
      setMessages((prev) => {
        if (!streamMessageId) {
          return [
            ...prev,
            {
              id: `assistant-${data.request_id ?? Date.now()}`,
              text: data.data,
              user: 'SYNAPSE',
            },
          ];
        }
        return prev.map((msg) => (
          msg.id === streamMessageId
            ? { ...msg, text: data.data, streaming: false }
            : msg
        ));
      });
      streamMessageIdRef.current = null;
      activeRequestIdRef.current = null;
    };
    const onToken = (data: { data: string; scope?: string } & RequestEvent) => {
      if (!isCurrentRequest(data) || data.scope === 'step' || !data.data) return;
      setIsTyping(false);
      setMessages((prev) => {
        const requestId = data.request_id ?? activeRequestIdRef.current ?? 'stream';
        const streamMessageId = streamMessageIdRef.current ?? `stream-${requestId}`;
        streamMessageIdRef.current = streamMessageId;
        if (!prev.some((msg) => msg.id === streamMessageId)) {
          return [
            ...prev,
            {
              id: streamMessageId,
              text: data.data,
              user: 'SYNAPSE',
              streaming: true,
            },
          ];
        }
        return prev.map((msg) => (
          msg.id === streamMessageId ? { ...msg, text: msg.text + data.data } : msg
        ));
      });
    };
    const onPlanGenerated = (data: { plan: Plan; replanned?: boolean } & RequestEvent) => {
      if (!isCurrentRequest(data)) return;
      setPlan(data.plan);
      if (data.replanned) {
        // Keep only statuses for step IDs that exist in the new plan.
        const liveIds = new Set(data.plan.steps.map((s) => s.step_id));
        setStepStatuses((prev) => {
          const next: StepStateMap = {};
          for (const [k, v] of Object.entries(prev)) {
            const id = Number(k);
            if (liveIds.has(id)) next[id] = v;
          }
          return next;
        });
      } else {
        setStepStatuses({});
      }
    };
    const onStepStatus = (data: {
      step_id: number;
      status: StepStatus;
      message?: string;
    } & RequestEvent) => {
      if (!isCurrentRequest(data)) return;
      setStepStatuses((prev) => ({
        ...prev,
        [data.step_id]: { status: data.status, message: data.message },
      }));
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('command_output', onCommandOutput);
    socket.on('token', onToken);
    socket.on('plan_generated', onPlanGenerated);
    socket.on('step_status', onStepStatus);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('command_output', onCommandOutput);
      socket.off('token', onToken);
      socket.off('plan_generated', onPlanGenerated);
      socket.off('step_status', onStepStatus);
    };
  }, []);

  return (
    <>
      <ParticleBackground />
      {showEntryScreen ? (
        <EntryScreen onEnter={() => setShowEntryScreen(false)} />
      ) : (
        <div className="flex flex-col h-screen bg-transparent text-gray-200 animate-fade-in">
          <header className="p-4 text-center border-b border-cyan-500/20 bg-black/30 backdrop-blur-sm">
            <h1 className="font-orbitron text-2xl font-bold text-cyan-400 drop-shadow-[0_0_8px_rgba(0,255,255,0.6)]">
              S Y N A P S E
            </h1>
            <p className={`text-xs uppercase tracking-widest ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
              {isConnected ? '● SYSTEM ONLINE' : '● CONNECTION LOST'}
            </p>
            <div className="mt-1 flex justify-center">
              <ModelIndicator />
            </div>
          </header>

          <div className="flex flex-1 min-h-0">
            <aside className="hidden md:block w-80 border-r border-cyan-500/20 bg-black/20 backdrop-blur-sm">
              <PlanPanel plan={plan} statuses={stepStatuses} />
            </aside>
            <main className="flex flex-col flex-1 min-w-0">
              <div className="md:hidden">
                {plan && (
                  <details className="border-b border-cyan-500/20 bg-black/20">
                    <summary className="px-4 py-2 text-xs uppercase tracking-widest text-cyan-300 cursor-pointer">
                      Plan ({plan.steps.length} steps)
                    </summary>
                    <PlanPanel plan={plan} statuses={stepStatuses} />
                  </details>
                )}
              </div>
              <ChatDisplay messages={messages} isTyping={isTyping} />
              <InputBar onSendMessage={handleSendMessage} />
            </main>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
