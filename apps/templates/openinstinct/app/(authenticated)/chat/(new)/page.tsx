import { NewChat } from "./_components/new-chat";

export default function NewChatPage() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-background px-4 pb-[10vh] text-foreground sm:px-6">
      <div className="flex w-full max-w-xl flex-col items-center gap-4">
        <h1 className="type-section-title">Local Vault Assistant</h1>
        <NewChat />
      </div>
    </div>
  );
}
