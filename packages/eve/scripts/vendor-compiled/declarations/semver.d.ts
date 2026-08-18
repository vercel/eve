export interface SemVer {
  major: number;
}

export interface Comparator {
  value: string;
}

export interface Range {
  set: Comparator[][];
}

export interface SemVerApi {
  Range: new (range: string) => Range;
  intersects(rangeA: string, rangeB: string): boolean;
  minVersion(range: string): SemVer | null;
  satisfies(version: string, range: string): boolean;
  subset(candidateRange: string, requiredRange: string): boolean;
  validRange(range: string): string | null;
}

declare const semver: SemVerApi;

export default semver;
