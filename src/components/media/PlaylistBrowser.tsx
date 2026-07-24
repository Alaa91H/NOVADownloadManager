import React from 'react';
import { ListMusic, CheckSquare, Square } from 'lucide-react';
import type { MediaPlaylistEntry } from '../../api/novaClient';
import { formatDuration } from './mediaHelpers';

interface PlaylistBrowserProps {
  playlistResult: { title: string; entries: MediaPlaylistEntry[] };
  selectAllPlaylist: boolean;
  onSelectAllChange: (v: boolean) => void;
  selectedItems: Set<number>;
  onSelectedItemsChange: (items: Set<number>) => void;
}

export const PlaylistBrowser: React.FC<PlaylistBrowserProps> = ({
  playlistResult,
  selectAllPlaylist,
  onSelectAllChange,
  selectedItems,
  onSelectedItemsChange,
}) => (
  <div className="bg-[var(--bg-hover)]/40 border border-[var(--border-color)]/30 rounded-xl overflow-hidden">
    <div className="flex items-center justify-between p-3 border-b border-[var(--border-color)]/20">
      <div className="flex items-center gap-2 min-w-0">
        <ListMusic className="w-4 h-4 text-[var(--info)] shrink-0" />
        <span className="text-xs font-bold text-[var(--text-primary)] truncate">
          {playlistResult.title || 'Playlist'}
        </span>
        <span className="text-[10px] text-[var(--text-muted)] shrink-0">({playlistResult.entries.length})</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {!selectAllPlaylist && selectedItems.size > 0 && (
          <span className="text-[10px] text-[var(--info)] font-semibold">{selectedItems.size} selected</span>
        )}
        <button
          type="button"
          onClick={() => {
            onSelectAllChange(!selectAllPlaylist);
            if (!selectAllPlaylist) onSelectedItemsChange(new Set(playlistResult.entries.map((e) => e.index)));
          }}
          className="flex items-center gap-1 text-[10px] text-[var(--info)] hover:text-[var(--info)] transition-colors cursor-pointer"
        >
          {selectAllPlaylist ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
          {selectAllPlaylist ? 'All' : 'Custom'}
        </button>
      </div>
    </div>
    <div className="max-h-64 overflow-y-auto divide-y divide-[var(--border-color)]/10 scrollbar-thin">
      {playlistResult.entries.map((entry) => {
        const isSelected = selectAllPlaylist || selectedItems.has(entry.index);
        return (
          <div
            key={entry.id}
            className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-[var(--bg-hover)]/50 transition-colors ${
              isSelected ? '' : 'opacity-40'
            }`}
            onClick={() => {
              if (selectAllPlaylist) return;
              const next = new Set(selectedItems);
              if (next.has(entry.index)) next.delete(entry.index);
              else next.add(entry.index);
              onSelectedItemsChange(next);
            }}
          >
            {selectAllPlaylist ? (
              <CheckSquare className="w-3.5 h-3.5 text-[var(--success)] shrink-0" />
            ) : isSelected ? (
              <CheckSquare className="w-3.5 h-3.5 text-[var(--info)] shrink-0" />
            ) : (
              <Square className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
            )}
            <span className="text-[10px] text-[var(--text-muted)] w-5 shrink-0 text-right font-mono">
              {entry.index}
            </span>
            {entry.thumbnail && (
              <img
                src={entry.thumbnail}
                alt=""
                className="w-12 h-8 rounded object-cover shrink-0 bg-black/40"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            )}
            <span className="text-[11px] text-[var(--text-primary)] truncate min-w-0 flex-1">{entry.title}</span>
            {entry.duration > 0 && (
              <span className="text-[10px] text-[var(--text-muted)] shrink-0 font-mono">
                {formatDuration(entry.duration)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  </div>
);
