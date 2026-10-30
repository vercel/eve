"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Size {
  readonly width: number;
  readonly height: number;
}

export interface LiveStreamState {
  readonly connection: "idle" | "connecting" | "live" | "offline";
  /** The page's URL, from agent-browser's stream; the desktop stream sends none. */
  readonly url: string | null;
  /** The coordinate space input is measured in: the page's CSS viewport, or the screen's pixels. */
  readonly viewport: Size | null;
  /** Pixel size of the last frame drawn, which sets the view's shape. */
  readonly frame: Size | null;
}

type ServerMessage =
  | { type: "frame"; data: string; metadata: { deviceWidth: number; deviceHeight: number } }
  | { type: "url"; url: string }
  | { type: string };

const INITIAL: LiveStreamState = {
  connection: "idle",
  url: null,
  viewport: null,
  frame: null,
};

/**
 * Draw a sandbox device's live stream on `canvas`, and send it input. Both the browser and the
 * desktop speak agent-browser's stream protocol; see agent/lib/live-sources.ts.
 */
export function useLiveStream(
  canvas: React.RefObject<HTMLCanvasElement | null>,
  url: string | undefined,
) {
  const [state, setState] = useState<LiveStreamState>(INITIAL);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    setState(url === undefined ? INITIAL : { ...INITIAL, connection: "connecting" });
    if (url === undefined) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const update = (patch: Partial<LiveStreamState>) => {
      if (!disposed) setState((current) => ({ ...current, ...patch }));
    };

    function connect() {
      if (disposed) return;
      const ws = new WebSocket(url!);
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        update({ connection: "live" });
      };
      ws.onclose = () => {
        if (socket.current === ws) socket.current = null;
        if (disposed) return;
        update({ connection: "offline" });
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 8000));
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === "frame") {
          const { data, metadata } = message as Extract<ServerMessage, { type: "frame" }>;
          void paint(canvas.current, `data:image/jpeg;base64,${data}`).then((frame) => {
            if (frame === undefined) return;
            // agent-browser reports the window's height (720) rather than the page's, which is
            // shorter, so only the width is trustworthy. The frame has the page's shape.
            const viewport = {
              width: metadata.deviceWidth,
              height: Math.round((frame.height * metadata.deviceWidth) / frame.width),
            };
            setState((current) =>
              current.frame?.width === frame.width &&
              current.frame.height === frame.height &&
              current.viewport?.width === viewport.width &&
              current.viewport.height === viewport.height
                ? current
                : { ...current, frame, viewport },
            );
          });
        } else if (message.type === "url") {
          update({ url: (message as { url: string }).url });
        }
      };
    }

    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      socket.current?.close();
      socket.current = null;
    };
  }, [canvas, url]);

  const send = useCallback((message: Record<string, unknown>) => {
    const ws = socket.current;
    if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  return { ...state, send };
}

function paint(canvas: HTMLCanvasElement | null, src: string): Promise<Size | undefined> {
  return new Promise((resolve) => {
    if (canvas === null) return resolve(undefined);
    const image = new Image();
    image.onload = () => {
      if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
      }
      canvas.getContext("2d")?.drawImage(image, 0, 0);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => resolve(undefined);
    image.src = src;
  });
}
