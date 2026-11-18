// The helper model: what the app uses for small jobs outside sessions (memory notes after a turn, Auto
// mode's checks, second opinions, reading a page for one question).
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { ModelSource } from '@shared/types';
import { api } from '../../lib/api';
import { toastError } from '../../lib/store';
import { MODEL_SOURCES } from '../../components/AgentPickers';
import { MenuLabel, OptionRow, Picker, Throbber } from '../../components/ui';
import { Group, Row } from './kit';

interface HelperState {
  model: string;
  options: { value: string; label: string; detail?: string; vision?: boolean; source?: ModelSource; via?: string }[];
}

/** What the prompt suggestion falls back to when the session's own model cannot be asked (server/answers/prompt-next.ts). */
interface FallbackState {
  on: boolean;
  fallback: string;
  options: { value: string; label: string; detail?: string; vision?: boolean }[];
}

export function HelperModel() {
  const [st, setSt] = useState<HelperState | null>(null);
  useEffect(() => {
    api<HelperState>('/api/helper')
      .then(setSt)
      .catch(() => {});
  }, []);
  const cur = st && (st.options.find((o) => o.value === st.model) ?? st.options[0]);
  const pick = (model: string) => api<HelperState>('/api/helper', { method: 'PUT', body: { model } }).then(setSt).catch(toastError);
  return (
    <Group title="Helper model" info="The model for the app’s small jobs beside your sessions: writing memory notes, checking steps in Auto mode, second opinions, reading a page for one question.">
      <Row
        label="Model"
        hint={
          <>
            <div>For small jobs beside your sessions: memory notes, checks in Auto mode, second opinions</div>
            {cur?.detail && (
              <div className="mt-0.5" translate="no">
                {cur.detail}
              </div>
            )}
          </>
        }
        control={
          st ? (
            <Picker icon={<Sparkles size={14} className="text-fg-3" />} value={cur?.label ?? 'Automatic'} title="The helper model" width={300}>
              {(close) => {
                const row = (o: HelperState['options'][number]) => (
                  <OptionRow
                    key={o.value}
                    label={o.label}
                    hint={[o.detail, o.vision ? 'sees images' : ''].filter(Boolean).join(' · ')}
                    selected={o.value === st.model}
                    onClick={() => {
                      close();
                      void pick(o.value);
                    }}
                  />
                );
                // Automatic first, then Custom's models under where they come from.
                return (
                  <>
                    {st.options.filter((o) => !o.source).map(row)}
                    {MODEL_SOURCES.map(({ source, title }) => {
                      const rows = st.options.filter((o) => o.source === source);
                      return (
                        rows.length > 0 && (
                          <div key={source}>
                            <MenuLabel>{title}</MenuLabel>
                            {rows.map(row)}
                          </div>
                        )
                      );
                    })}
                  </>
                );
              }}
            </Picker>
          ) : (
            <Throbber className="text-fg-3" />
          )
        }
      />
      <PromptFallback />
    </Group>
  );
}

/** Which model suggests your next message when the session's own model cannot be asked alone: the helper model, or one of Custom's. */
function PromptFallback() {
  const [st, setSt] = useState<FallbackState | null>(null);
  useEffect(() => {
    api<FallbackState>('/api/prompt-suggestions/settings')
      .then(setSt)
      .catch(() => {});
  }, []);
  const pick = (fallback: string) =>
    api<FallbackState>('/api/prompt-suggestions/settings', { method: 'PUT', body: { fallback } }).then(setSt).catch(toastError);
  const cur = st && (st.options.find((o) => o.value === st.fallback) ?? st.options[0]);
  if (!st || !st.on) return null;
  return (
    <Row
      label="When the session's model cannot suggest"
      hint="The model that writes a suggestion when the one that answered cannot be asked on its own (Claude Code, Codex, another ACP agent)"
      control={
        <Picker icon={<Sparkles size={14} className="text-fg-3" />} value={cur?.label ?? 'Automatic'} title="The suggestion's fallback" width={300}>
          {(close) =>
            st.options.map((o) => (
              <OptionRow
                key={o.value}
                label={o.label}
                hint={o.detail}
                selected={o.value === st.fallback}
                onClick={() => {
                  close();
                  void pick(o.value);
                }}
              />
            ))
          }
        </Picker>
      }
    />
  );
}
