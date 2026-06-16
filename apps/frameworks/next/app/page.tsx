import { App } from "./_chat/App";
import { AuthHeader } from "./_components/AuthHeader";
import "./_chat/styles.css";

export default function Home() {
  return (
    <>
      <AuthHeader />
      <App />
    </>
  );
}
