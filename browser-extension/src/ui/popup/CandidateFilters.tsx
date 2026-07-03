import React from 'react';
import { Candidate } from '../../contracts/candidate.schema';
import { useI18n } from '../../i18n/react';

type Filter = Candidate['mediaType'] | 'all';

export function CandidateFilters({ value, onChange }: { value: Filter; onChange(value: Filter): void }) {
  const { t } = useI18n();
  const filters: Array<{ value: Filter; label: string }> = [
    { value: 'all', label: t('candidate.filter.all') },
    { value: 'video', label: t('candidate.filter.video') },
    { value: 'audio', label: t('candidate.filter.audio') },
    { value: 'image', label: t('candidate.filter.image') },
    { value: 'document', label: t('candidate.filter.document') },
    { value: 'archive', label: t('candidate.filter.archive') },
    { value: 'app', label: t('candidate.filter.app') },
    { value: 'torrent', label: t('candidate.filter.torrent') },
    { value: 'magnet', label: t('candidate.filter.magnet') },
    { value: 'manifest', label: t('candidate.filter.manifest') },
    { value: 'other', label: t('candidate.filter.other') },
  ];
  return <nav className="adm-filter-row" role="tablist" aria-label={t('candidate.filter.aria')}>
    {filters.map((filter) => <button className="adm-filter-chip" role="tab" key={filter.value} onClick={() => onChange(filter.value)} aria-pressed={value === filter.value} aria-selected={value === filter.value}>{filter.label}</button>)}
  </nav>;
}
export default CandidateFilters;
