import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState, type FormEvent } from "react";
import { useEveAgent } from "eve/react";

const getHostMarker = createServerFn().handler(async () => "Start server function is running");

export const Route = createFileRoute("/")({
  loader: () => getHostMarker(),
  component: Home,
});

function Home() {
  const hostMarker = Route.useLoaderData();
  const agent = useEveAgent();
  const [message, setMessage] = useState("");
  const isBusy = agent.status === "submitted" || agent.status === "streaming";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = message.trim();
    if (text.length === 0 || isBusy) return;
    setMessage("");
    void agent.send({ message: text });
  }

  return (
    <main>
      <h1>TanStack Start with eve</h1>
      <p>{hostMarker}</p>
      <ol>
        {agent.data.messages.map((entry) => (
          <li key={entry.id}>
            <strong>{entry.role}</strong>{" "}
            {entry.parts.map((part) => (part.type === "text" ? part.text : "")).join("")}
          </li>
        ))}
      </ol>
      <form onSubmit={submit}>
        <label>
          Message
          <input
            disabled={isBusy}
            onChange={(event) => setMessage(event.currentTarget.value)}
            value={message}
          />
        </label>
        <button disabled={isBusy} type="submit">
          Send
        </button>
      </form>
    </main>
  );
}
