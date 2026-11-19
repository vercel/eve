export function EveLockup() {
  return (
    <span aria-hidden="true" className="inline-flex items-center gap-2.5 text-foreground">
      <svg className="size-5" fill="currentColor" viewBox="0 0 24 24">
        <path d="M12 3 23 21H1L12 3Z" />
      </svg>
      <span className="h-4 w-px bg-border" />
      <svg className="h-3.5 w-auto" fill="currentColor" viewBox="0 0 169 53">
        <path d="M169 8.47h-51.39L81.73 53H70.36L113 0H169zM169 44.51v8.47h-45.87V44.5zM45.87 52.98H0V44.5h45.87zM38.66 30.55H0v-8.47h38.66z" />
        <path d="M169 30.55h-38.66v-8.47H169zM75.52 8.47H0V0h75.52z" />
      </svg>
    </span>
  );
}

export function GitHubMark() {
  return (
    // GitHub Octicons mark-github-16. Copyright (c) 2026 GitHub Inc. (MIT).
    <svg aria-hidden="true" className="size-4 shrink-0" fill="currentColor" viewBox="0 0 16 16">
      <path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
    </svg>
  );
}
