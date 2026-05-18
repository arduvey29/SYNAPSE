import React, { useEffect, useRef } from 'react';
import { TypingIndicator } from './TypingIndicator';
import { UserBubble } from './UserBubble';
import { TextBubble } from './TextBubble';
import { StepBubble } from './StepBubble';
import { SummaryBubble } from './SummaryBubble';
import type { Message } from '../types/messages';

export type { Message };

interface ChatDisplayProps {
  messages: Message[];
  isTyping: boolean;
}

export const ChatDisplay: React.FC<ChatDisplayProps> = ({ messages, isTyping }) => {
  const endOfMessagesRef = useRef<null | HTMLDivElement>(null);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  return (
    <div className="flex-1 p-4 overflow-y-auto">
      {messages.map((msg) => {
        switch (msg.kind) {
          case 'user':          return <UserBubble    key={msg.id} msg={msg} />;
          case 'agent-text':    return <TextBubble    key={msg.id} msg={msg} />;
          case 'agent-step':    return <StepBubble    key={msg.id} msg={msg} />;
          case 'agent-summary': return <SummaryBubble key={msg.id} msg={msg} />;
        }
      })}
      {isTyping && (
        <div className="mb-4">
          <div
            className="inline-block p-4 rounded-lg shadow-lg bg-gray-700/30 border border-gray-500/50"
            style={{ backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' }}
          >
            <TypingIndicator />
          </div>
        </div>
      )}
      <div ref={endOfMessagesRef} />
    </div>
  );
};
