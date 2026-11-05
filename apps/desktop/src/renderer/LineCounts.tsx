export function LineCounts(props: { additions: number; deletions: number }) {
  return (
    <span className="flex shrink-0 gap-1 font-mono text-[10px]">
      {props.deletions > 0 && <span className="text-deleted">−{props.deletions}</span>}
      <span className="text-added">+{props.additions}</span>
    </span>
  )
}
