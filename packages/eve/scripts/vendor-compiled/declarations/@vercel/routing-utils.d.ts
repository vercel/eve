export interface Header {
  readonly source: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
  readonly has?: readonly unknown[];
  readonly missing?: readonly unknown[];
}

export interface Route {
  readonly [key: string]: unknown;
}

export interface RouteApiError {
  readonly code: string;
  readonly message: string;
  readonly link?: string;
}

export interface RoutingUtilsApi {
  getTransformedRoutes(vercelConfig: { headers?: readonly Header[] }): {
    routes: Route[] | null;
    error: RouteApiError | null;
  };
}

declare const routingUtils: RoutingUtilsApi;

export default routingUtils;
