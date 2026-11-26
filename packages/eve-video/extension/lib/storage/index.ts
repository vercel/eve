export {
  inMemory,
  type InMemoryVideoStorage,
  type InMemoryVideoStorageOptions,
} from "./in-memory.ts";
export { localDisk, type LocalDiskVideoStorageOptions } from "./local-disk.ts";
export type {
  StoredVideo,
  StoredVideoContent,
  VideoStorage,
  VideoStorageDeleteInput,
  VideoStorageGetInput,
  VideoStoragePutInput,
  VideoStorageVisibility,
} from "./types.ts";
