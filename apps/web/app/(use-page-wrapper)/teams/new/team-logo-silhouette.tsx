type TeamLogoSilhouetteProps = {
  className?: string;
};

export function TeamLogoSilhouette({ className }: TeamLogoSilhouetteProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <circle cx="12" cy="8" r="4.5" />
      <path d="M12 13.5c-4.7 0-8 2.9-8 6.5h16c0-3.6-3.3-6.5-8-6.5Z" />
    </svg>
  );
}
