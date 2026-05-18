import { useState, useEffect } from 'react';

export const useScrambleEffect = (finalText: string) => {
  const [displayedText, setDisplayedText] = useState('');
  const chars = '!<>-_\\/[]{}—=+*^?#';

  useEffect(() => {
    let frameId: number;
    let frame = 0;
    // Scale delay so total animation stays under ~1.5 seconds regardless of message length
    const delay = Math.max(0.1, Math.min(2, 60 / Math.max(finalText.length, 1)));
    const queue = finalText.split('').map((char, i) => ({
        to: char,
        start: Math.floor(i * delay),
        end: Math.floor(i * delay) + 6,
    }));

    const update = () => {
        let output = '';
        let complete = 0;
        for (let i = 0; i < queue.length; i++) {
            const { to, start, end } = queue[i];
            if (frame >= end) {
                complete++;
                output += to;
            } else if (frame >= start) {
                if (Math.random() < 0.15) { // Lower chance to reveal early
                    output += to;
                } else {
                    output += chars[Math.floor(Math.random() * chars.length)];
                }
            } else {
                output += ' ';
            }
        }
        setDisplayedText(output);
        if (complete === queue.length) {
            cancelAnimationFrame(frameId);
        } else {
            frame++;
            frameId = requestAnimationFrame(update);
        }
    };
    
    frameId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frameId);
  }, [finalText]);

  return displayedText;
};
