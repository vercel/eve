export type RegistrySource =
  | string
  | {
      url: string;
      params?: Record<string, string>;
      headers?: Record<string, string>;
    };

export interface RegistryConfig {
  registries?: Record<string, RegistrySource>;
}

export interface AddRegistryItemsOptions {
  cwd?: string;
  config?: RegistryConfig;
  overwrite?: boolean;
}

export interface RegistrySearchItem {
  registry: string;
  name: string;
  addCommandArgument: string;
  type?: string;
  description?: string;
}

export interface RegistrySearchResult {
  items: RegistrySearchItem[];
  pagination: {
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
  };
  errors?: Array<{ message: string; registry: string }>;
}

export function addRegistryItems(items: string[], options?: AddRegistryItemsOptions): Promise<void>;

export function getRegistryItems(
  items: string[],
  options?: { config?: RegistryConfig; useCache?: boolean },
): Promise<unknown[]>;

export function searchRegistries(
  registries: string[],
  options?: {
    query?: string;
    types?: string[];
    limit?: number;
    offset?: number;
    config?: RegistryConfig;
    useCache?: boolean;
    continueOnError?: boolean;
  },
): Promise<RegistrySearchResult>;
