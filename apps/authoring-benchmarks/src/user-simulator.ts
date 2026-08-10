import type { UserSimulator } from "./types.js";

/** Creates a user that supplies one phone number and rejects every other question. */
export function phoneNumberOnlyUser(phoneNumber: string): UserSimulator {
  let answered = false;
  return {
    async respond(message) {
      if (answered) {
        return { kind: "fail", reason: "The subject asked the user more than once." };
      }
      if (!isPhoneNumberQuestion(message)) {
        return {
          kind: "fail",
          reason: `The subject requested unsupported user input: ${JSON.stringify(message)}`,
        };
      }
      answered = true;
      return { kind: "answer", text: phoneNumber };
    },
  };
}

function isPhoneNumberQuestion(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("phone number") ||
    normalized.includes("imessage number") ||
    normalized.includes("number should")
  );
}
