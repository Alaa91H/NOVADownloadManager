export const parseTimeTo12Hour = (timeStr: string) => {
  if (!timeStr) return { hour12: 12, minute: 0, ampm: 'AM' as const };
  const [hour24Raw, minRaw] = timeStr.split(':').map(Number);
  const hour24 = Number.isFinite(hour24Raw) ? hour24Raw : 0;
  const min = Number.isFinite(minRaw) ? minRaw : 0;
  const ampm: 'AM' | 'PM' = hour24 >= 12 ? 'PM' : 'AM';
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12, minute: min, ampm };
};

export const formatTimeTo24Hour = (hour12: number, minute: number, ampm: 'AM' | 'PM') => {
  let hour24 = hour12;
  if (ampm === 'PM' && hour12 < 12) hour24 += 12;
  if (ampm === 'AM' && hour12 === 12) hour24 = 0;
  const hourStr = String(hour24).padStart(2, '0');
  const minStr = String(minute).padStart(2, '0');
  return `${hourStr}:${minStr}`;
};
