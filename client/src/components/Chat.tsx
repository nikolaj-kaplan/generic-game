import { useEffect, useRef } from 'react';
import { ChatMessage } from '../types';

interface ChatProps {
  messages: ChatMessage[];
}

export default function Chat({ messages }: ChatProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="chat-messages">
      {messages.map((msg) => (
        <ChatBubble key={msg.id} message={msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isAi = message.role === 'ai';
  const isSystem = message.role === 'system';

  if (isSystem) {
    return (
      <div className="chat-bubble chat-bubble--system">
        <MarkdownText content={message.content} />
      </div>
    );
  }

  return (
    <div className={`chat-bubble ${isAi ? 'chat-bubble--ai' : 'chat-bubble--player'}`}>
      {!isAi && message.playerName && (
        <span className="chat-bubble__author">{message.playerName}</span>
      )}
      <div className="chat-bubble__body">
        <MarkdownText content={message.content} />
      </div>
    </div>
  );
}

/** Minimal markdown renderer — only handles **bold** and newlines. */
function MarkdownText({ content }: { content: string }) {
  const parts = content.split(/(\*\*[^*]+\*\*)/g);
  const nodes = parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return (
      <span key={i}>
        {part.split('\n').map((line, j, arr) => (
          <span key={j}>
            {line}
            {j < arr.length - 1 && <br />}
          </span>
        ))}
      </span>
    );
  });
  return <>{nodes}</>;
}
