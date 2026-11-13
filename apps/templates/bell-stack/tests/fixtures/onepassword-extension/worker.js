const result = value => ({ success: true, result: value });
const valid = args => args.accessToken === "synthetic-access" && args.integrationKey === "synthetic-key";
globalThis.api = {
  initialization: { v1: { whenSettled: async () => "ready" } },
  agenticMode: { v1: { enable: async () => result({}) } },
  agenticAutofill: { v1: {
    createAccessRequest: async args => valid(args) ? result({ appLink: "https://approval.bell-test.example/approve", accessRequest: { id: "synthetic-request", entries: [{ id: "synthetic-entry" }] } }) : { success: false, error: { code: "invalidToken" } },
    getAccessRequestStatus: async args => valid(args) ? result({ state: "resolved", resolved: [{ entryId: "synthetic-entry", reference: "synthetic-reference" }] }) : { success: false, error: { code: "invalidToken" } },
    fillCredential: async args => {
      if (!valid(args) || args.resourcePath !== "synthetic-reference") return { success: false, error: { code: "invalidGrant" } };
      const tab = await chrome.tabs.get(args.tabId);
      if (tab.url !== "https://login.bell-test.example/login") return { success: false, error: { code: "wrongOrigin" } };
      await chrome.scripting.executeScript({ target: { tabId: args.tabId }, func: () => {
        document.querySelector("#username").value = "fixture-user";
        document.querySelector("#password").value = "fixture-password";
        document.querySelector("form").requestSubmit();
      } });
      return result({ status: "fill_submitted" });
    },
  } },
};
