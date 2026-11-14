import Chat from "../../chat";
export default async function Page({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return (
    <Chat sessionId={sessionId} demoUrl={process.env.BELL_DEMO_URL ?? "https://example.com"} />
  );
}
