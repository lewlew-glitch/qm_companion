export const pairLoading = `
.pair-loading { max-width: 42rem; padding: 24px 0; }
.pair-loading h2 { font-size: 18px; margin: 0 0 8px; }
.pair-loading p { color: var(--fg-2); line-height: 1.6; margin: 0 0 20px; }
.pair-loading-progress { height: 4px; max-width: 400px; border-radius: 4px; background: var(--border); overflow: hidden; }
.pair-loading-progress span { display: block; height: 100%; width: 35%; border-radius: inherit; background: var(--accent); }
@media (prefers-reduced-motion: no-preference) {
  .pair-loading-progress span { animation: pair-loading 1.5s ease-in-out infinite alternate; }
  @keyframes pair-loading { from { transform: translateX(0); } to { transform: translateX(185%); } }
}
`;
