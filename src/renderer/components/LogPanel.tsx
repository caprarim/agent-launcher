import React, { useEffect, useRef } from 'react';
import { LogEntry } from '../../shared/types';

interface Props {
  logs: LogEntry[];
  onClear: () => void;
}

export default function LogPanel({ logs, onClear }: Props): JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <>
      <div className="log-header">
        <h2>
          <span className="log-indicator" />
          Activity Log
        </h2>
        {logs.length > 0 && (
          <button className="btn btn-clear" onClick={onClear}>Clear</button>
        )}
      </div>

      <div className="log-container">
        {logs.length === 0 ? (
          <div className="log-empty">No activity yet. Launch agents to begin.</div>
        ) : (
          logs.map((entry, i) => (
            <div key={i} className={`log-entry log-${entry.level}`}>
              <span className="log-timestamp">{entry.timestamp}</span>
              <span className="log-message">
                {entry.level === 'success' && '✓ '}
                {entry.level === 'error' && '✗ '}
                {entry.level === 'warn' && '⚠ '}
                {entry.message}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </>
  );
}
