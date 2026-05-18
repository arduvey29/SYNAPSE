import { useEffect, useRef, useState } from 'react';
import { socket } from './socket';
import { ChatDisplay } from './components/ChatDisplay';
import { InputBar } from './components/InputBar';
import { EntryScreen } from './components/EntryScreen';
import { ParticleBackground } from './components/ParticleBackground';
import { ModelIndicator } from './components/ModelIndicator';
import { PlanDrawer } from './components/PlanDrawer';
import { useCompletionPulse } from './hooks/useCompletionPulse';
import { prettyLog, type LogPhase } from './lib/prettyLog';
import type { Plan } from './components/PlanPanel';
import type { StepStatus } from './components/StepStatusIcon';
import type {
  Message,
  AgentStepMessage,
  AgentSummaryMessage,
  AgentTextMessage,
  StepLog,
} from './types/messages';

type StepStateMap = Record<number, { status: StepStatus; message?: string }>;
type RequestEvent = { request_id?: string };

const createRequestId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const parsePlanCounts = (text: string): { doneSteps: number; totalSteps: number } => {
  // compose_final_answer header: "**Plan executed** (n/m steps completed)"
  const m = text.match(/\*\*Plan executed\*\* \((\d+)\/(\d+) steps completed\)/);
  if (!m) return { doneSteps: 0, totalSteps: 0 };
  return { doneSteps: Number(m[1]), totalSteps: Number(m[2]) };
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
  const { isPulsing, pulse } = useCompletionPulse(600);

  const handleSendMessage = (message: string) => {
    if (message.trim() === '') return;
    const requestId = createRequestId();
    activeRequestIdRef.current = requestId;
    streamMessageIdRef.current = null;
    socket.emit('execute_natural_command', { command: message, request_id: requestId });
    setMessages((prev) => [
      ...prev,
      { kind: 'user', id: `user-${requestId}`, text: message },
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
      const requestId = data.request_id ?? activeRequestIdRef.current ?? `${Date.now()}`;
      setMessages((prev) => {
        // Streaming single-react path: replace the in-flight agent-text bubble.
        if (streamMessageId) {
          return prev.map((msg): Message => (
            msg.kind === 'agent-text' && msg.id === streamMessageId
              ? { ...msg, text: data.data, streaming: false }
              : msg
          ));
        }
        // Multi-step path: emit a SummaryBubble if any step bubble exists for this requestId.
        const hasSteps = prev.some(
          (m) => m.kind === 'agent-step' && m.requestId === requestId,
        );
        if (hasSteps) {
          const { doneSteps, totalSteps } = parsePlanCounts(data.data);
          const stepsForReq = prev.filter(
            (m): m is AgentStepMessage => m.kind === 'agent-step' && m.requestId === requestId,
          );
          const allOk = stepsForReq.every((s) => s.status === 'done');
          const summary: AgentSummaryMessage = {
            kind: 'agent-summary',
            id: `summary-${requestId}`,
            requestId,
            text: data.data,
            doneSteps: doneSteps || stepsForReq.filter((s) => s.status === 'done').length,
            totalSteps: totalSteps || stepsForReq.length,
            ok: allOk,
          };
          return [...prev, summary];
        }
        // Fallback: single-react with no prior tokens (rare) — emit as agent-text.
        const textMsg: AgentTextMessage = {
          kind: 'agent-text',
          id: `assistant-${requestId}`,
          text: data.data,
        };
        return [...prev, textMsg];
      });
      streamMessageIdRef.current = null;
      activeRequestIdRef.current = null;
      pulse();
    };

    const onToken = (data: { data: string; scope?: string } & RequestEvent) => {
      if (!isCurrentRequest(data) || data.scope === 'step' || !data.data) return;
      setIsTyping(false);
      setMessages((prev) => {
        const requestId = data.request_id ?? activeRequestIdRef.current ?? 'stream';
        const streamMessageId = streamMessageIdRef.current ?? `stream-${requestId}`;
        streamMessageIdRef.current = streamMessageId;
        if (!prev.some((msg) => msg.kind === 'agent-text' && msg.id === streamMessageId)) {
          const newMsg: AgentTextMessage = {
            kind: 'agent-text',
            id: streamMessageId,
            text: data.data,
            streaming: true,
          };
          return [...prev, newMsg];
        }
        return prev.map((msg): Message => (
          msg.kind === 'agent-text' && msg.id === streamMessageId
            ? { ...msg, text: msg.text + data.data }
            : msg
        ));
      });
    };

    const onPlanGenerated = (data: { plan: Plan; replanned?: boolean } & RequestEvent) => {
      if (!isCurrentRequest(data)) return;
      const requestId = data.request_id ?? activeRequestIdRef.current ?? `${Date.now()}`;
      setPlan(data.plan);

      if (data.replanned) {
        // Keep statuses for step IDs that exist in the new plan.
        const liveIds = new Set(data.plan.steps.map((s) => s.step_id));
        setStepStatuses((prev) => {
          const next: StepStateMap = {};
          for (const [k, v] of Object.entries(prev)) {
            const id = Number(k);
            if (liveIds.has(id)) next[id] = v;
          }
          return next;
        });
        // In messages: drop pending step messages for this requestId whose stepId
        // is no longer in the new plan; preserve done/failed.
        setMessages((prev) => {
          const kept = prev.filter((m) => {
            if (m.kind !== 'agent-step' || m.requestId !== requestId) return true;
            if (m.status === 'done' || m.status === 'failed') return true;
            return liveIds.has(m.stepId);
          });
          const existingIds = new Set(
            kept
              .filter((m): m is AgentStepMessage => m.kind === 'agent-step' && m.requestId === requestId)
              .map((m) => m.stepId),
          );
          const newSteps: AgentStepMessage[] = data.plan.steps
            .filter((s) => !existingIds.has(s.step_id))
            .map((s) => ({
              kind: 'agent-step',
              id: `step-${requestId}-${s.step_id}`,
              requestId,
              stepId: s.step_id,
              description: s.description,
              intendedTool: s.intended_tool,
              status: 'pending',
              logs: [],
            }));
          return [...kept, ...newSteps];
        });
      } else {
        setStepStatuses({});
        // Initial plan: append one agent-step per plan step.
        setMessages((prev) => {
          const newSteps: AgentStepMessage[] = data.plan.steps.map((s) => ({
            kind: 'agent-step',
            id: `step-${requestId}-${s.step_id}`,
            requestId,
            stepId: s.step_id,
            description: s.description,
            intendedTool: s.intended_tool,
            status: 'pending',
            logs: [],
          }));
          return [...prev, ...newSteps];
        });
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
      const requestId = data.request_id ?? activeRequestIdRef.current;
      if (!requestId) return;
      setMessages((prev) => prev.map((m): Message => (
        m.kind === 'agent-step' && m.requestId === requestId && m.stepId === data.step_id
          ? { ...m, status: data.status, summary: data.message ?? m.summary }
          : m
      )));
    };

    const onToolCall = (data: {
      tool: string;
      status: LogPhase;
      input?: string;
      output?: string;
    } & RequestEvent) => {
      if (!isCurrentRequest(data)) return;
      const requestId = data.request_id ?? activeRequestIdRef.current;
      if (!requestId) return;
      const payload = data.status === 'running' ? data.input : data.output;
      const log: StepLog = {
        tool: data.tool,
        phase: data.status,
        raw: payload,
        prettyLine: prettyLog(data.tool, data.status, payload),
      };
      setMessages((prev) => {
        // Attach to the currently-running step for this requestId; fall back to
        // the last agent-step for this requestId.
        const stepsForReq = prev.filter(
          (m): m is AgentStepMessage => m.kind === 'agent-step' && m.requestId === requestId,
        );
        if (stepsForReq.length === 0) return prev;
        const target =
          stepsForReq.find((s) => s.status === 'running') ?? stepsForReq[stepsForReq.length - 1];
        return prev.map((m): Message => (
          m.kind === 'agent-step' && m.id === target.id
            ? { ...m, logs: [...m.logs, log] }
            : m
        ));
      });
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('command_output', onCommandOutput);
    socket.on('token', onToken);
    socket.on('plan_generated', onPlanGenerated);
    socket.on('step_status', onStepStatus);
    socket.on('tool_call', onToolCall);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('command_output', onCommandOutput);
      socket.off('token', onToken);
      socket.off('plan_generated', onPlanGenerated);
      socket.off('step_status', onStepStatus);
      socket.off('tool_call', onToolCall);
    };
  }, [pulse]);

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

          <PlanDrawer plan={plan} statuses={stepStatuses} />

          <div className={`flex-1 min-h-0 flex flex-col ${isPulsing ? 'animate-completion-pulse' : ''}`}>
            <ChatDisplay messages={messages} isTyping={isTyping} />
            <InputBar onSendMessage={handleSendMessage} />
          </div>
        </div>
      )}
    </>
  );
}

export default App;
