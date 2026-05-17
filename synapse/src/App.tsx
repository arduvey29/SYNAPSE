import { useState, useEffect } from 'react';
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

function App() {
  const [showEntryScreen, setShowEntryScreen] = useState(true);
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [stepStatuses, setStepStatuses] = useState<StepStateMap>({});

  const handleSendMessage = (message: string) => {
    if (message.trim() === '') return;
    socket.emit('execute_natural_command', { command: message });
    setMessages((prev) => [...prev, { text: message, user: 'You' }]);
    setIsTyping(true);
    setPlan(null);
    setStepStatuses({});
  };

  useEffect(() => {
    const onConnect = () => setIsConnected(true);
    const onDisconnect = () => setIsConnected(false);
    const onCommandOutput = (data: { data: string }) => {
      setIsTyping(false);
      setMessages((prev) => [...prev, { text: data.data, user: 'SYNAPSE' }]);
    };
    const onPlanGenerated = (data: { plan: Plan; replanned?: boolean }) => {
      setPlan(data.plan);
      if (!data.replanned) setStepStatuses({});
    };
    const onStepStatus = (data: {
      step_id: number;
      status: StepStatus;
      message?: string;
    }) => {
      setStepStatuses((prev) => ({
        ...prev,
        [data.step_id]: { status: data.status, message: data.message },
      }));
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('command_output', onCommandOutput);
    socket.on('plan_generated', onPlanGenerated);
    socket.on('step_status', onStepStatus);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('command_output', onCommandOutput);
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
