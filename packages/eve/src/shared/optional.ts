export type Optional<T, K extends keyof T> = {
  [P in keyof (Omit<T, K> & Partial<Pick<T, K>>)]: (Omit<T, K> & Partial<Pick<T, K>>)[P];
};
