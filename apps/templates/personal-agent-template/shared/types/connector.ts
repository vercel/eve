export type ConnectorStatus =
  | { state: "connected"; installationId?: string; label?: string }
  | { state: "not_connected" }
  | { state: "installation_required" }
  | { state: "setup_required"; message: string; hint?: string }
  | { state: "error"; message: string };

export type ConnectorState = ConnectorStatus["state"];

/** API response — one row in the integrations hub. */
export interface ConnectorSummary {
  id: string;
  name: string;
  description: string;
  icon: string;
  connectorUid: string;
  connectionName: string;
  testLabel: string;
  status: ConnectorStatus;
  connectedAs?: string;
}

/** Server registry entry in `server/connectors.ts`. */
export interface ConnectorDef {
  id: string;
  name: string;
  description: string;
  /** Vercel Connect connector UID — must match `agent/connections/<id>.ts`. */
  connector: string;
  /** Eve connection name from `agent/connections/<connectionName>.ts`. */
  connectionName: string;
  icon: string;
  scopes: string[];
  test: {
    label: string;
    run: (token: string) => Promise<string[]>;
  };
}

export interface ParsedTestResult {
  id?: string;
  tag?: string;
  title: string;
}
