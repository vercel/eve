import Chat from "./chat";
export default function Page() {
  return <Chat demoUrl={process.env.BELL_DEMO_URL ?? "https://example.com"} />;
}
