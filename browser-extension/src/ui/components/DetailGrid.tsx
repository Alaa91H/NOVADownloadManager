import React from 'react';

export type DetailItem = { label: string; value?: React.ReactNode };

export function DetailGrid({ items }: { items: DetailItem[] }) {
  const visible = items.filter((item) => item.value !== undefined && item.value !== null && item.value !== '');
  if (!visible.length) return null;
  return <dl className="nova-detail-grid">
    {visible.map((item) => <React.Fragment key={item.label}>
      <dt>{item.label}</dt>
      <dd>{item.value}</dd>
    </React.Fragment>)}
  </dl>;
}

export default DetailGrid;
