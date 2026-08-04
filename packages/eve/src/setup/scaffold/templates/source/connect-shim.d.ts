declare module "@vercel/connect/eve" {
  export function connect(connector: string): never;
  export function connectPhotonCredentials(connector: string): never;
  export function connectSlackCredentials(connector: string): never;
}
