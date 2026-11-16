// Generic editor for a group of platform settings (GET /api/settings, PATCH only changed keys).

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { getSettings, patchSettings } from '../../api/endpoints';
import { qk } from '../../api/keys';
import type { SettingKey, SettingsPatch } from '../../api/types';
import { Alert, Button, Card, CardBody, CardHeader, ErrorState, Field, Input, LoadingState, Select, Textarea, Toggle } from '../../components/ui';
import { parseJson, stringify } from '../../lib/json';

export type SettingField =
  | { key: SettingKey; label: string; kind: 'text'; hint?: string; placeholder?: string; nullable?: boolean; mono?: boolean }
  | { key: SettingKey; label: string; kind: 'int' | 'float'; hint?: string; min?: number }
  | { key: SettingKey; label: string; kind: 'bool'; hint?: string }
  | { key: SettingKey; label: string; kind: 'select'; hint?: string; options: { value: string; label: string }[] }
  | { key: SettingKey; label: string; kind: 'lines'; hint?: string; placeholder?: string }
  | { key: SettingKey; label: string; kind: 'json'; hint?: string; expect: 'object' | 'array'; rows?: number };

type Draft = Record<string, string | boolean>;

function toDraft(field: SettingField, value: unknown): string | boolean {
  switch (field.kind) {
    case 'bool':
      return value === true;
    case 'lines':
      return Array.isArray(value) ? value.join('\n') : '';
    case 'json':
      return stringify(value ?? (field.expect === 'array' ? [] : {}));
    default:
      return value === null || value === undefined ? '' : String(value);
  }
}

function fromDraft(field: SettingField, raw: string | boolean): { value?: unknown; error?: string } {
  if (field.kind === 'bool') return { value: raw === true };
  const text = String(raw);
  switch (field.kind) {
    case 'text':
      return { value: text.trim() === '' && field.nullable ? null : text.trim() };
    case 'select':
      return { value: text };
    case 'int': {
      const value = Number(text);
      if (!text.trim() || !Number.isInteger(value)) return { error: 'A whole number is required.' };
      if (field.min !== undefined && value < field.min) return { error: `Minimum ${field.min}.` };
      return { value };
    }
    case 'float': {
      const value = Number(text);
      if (!text.trim() || !Number.isFinite(value)) return { error: 'A number is required.' };
      if (field.min !== undefined && value < field.min) return { error: `Minimum ${field.min}.` };
      return { value };
    }
    case 'lines':
      return { value: text.split('\n').map((line) => line.trim()).filter(Boolean) };
    case 'json': {
      const parsed = parseJson(text, field.expect, { allowEmpty: false });
      return parsed.ok ? { value: parsed.value } : { error: parsed.error };
    }
  }
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: getSettings });
}

export function SettingsForm({
  title,
  description,
  fields,
  children,
}: {
  title: string;
  description?: string;
  fields: SettingField[];
  children?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const values = settings.data?.values;
  const initial = useMemo<Draft>(
    () => Object.fromEntries(fields.map((f) => [f.key, toDraft(f, values?.[f.key])])),
    [fields, values],
  );
  const [draft, setDraft] = useState<Draft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(initial), [initial]);

  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => patchSettings(patch),
    onSuccess: (data) => {
      queryClient.setQueryData(qk.settings, data);
      void queryClient.invalidateQueries({ queryKey: qk.providers });
      void queryClient.invalidateQueries({ queryKey: qk.workspaces });
      void queryClient.invalidateQueries({ queryKey: qk.dashboard });
      void queryClient.invalidateQueries({ queryKey: qk.agents });
      setSaved(true);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    if (!values) return;
    const patch: Record<string, unknown> = {};
    const nextErrors: Record<string, string> = {};
    for (const field of fields) {
      const result = fromDraft(field, draft[field.key] ?? '');
      if (result.error) {
        nextErrors[field.key] = result.error;
        continue;
      }
      if (JSON.stringify(result.value) !== JSON.stringify(values[field.key] ?? null)) patch[field.key] = result.value;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    if (Object.keys(patch).length === 0) {
      setSaved(true);
      return;
    }
    save.mutate(patch as SettingsPatch);
  }

  return (
    <Card>
      <CardHeader title={title} description={description} />
      <CardBody>
        {settings.isPending ? (
          <LoadingState />
        ) : settings.isError ? (
          <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {children}
            <div className="grid gap-4 md:grid-cols-2">
              {fields.map((field) => (
                <SettingInput
                  key={field.key}
                  field={field}
                  value={draft[field.key] ?? ''}
                  error={errors[field.key]}
                  onChange={(value) => {
                    setSaved(false);
                    setDraft((d) => ({ ...d, [field.key]: value }));
                  }}
                />
              ))}
            </div>
            {save.isError && <ErrorState compact error={save.error} title="Not saved" />}
            {saved && !save.isPending && <Alert tone="green">Saved.</Alert>}
            <div className="flex justify-end">
              <Button type="submit" variant="primary" icon={<Save className="h-4 w-4" />} loading={save.isPending}>
                Save
              </Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

function SettingInput({
  field,
  value,
  error,
  onChange,
}: {
  field: SettingField;
  value: string | boolean;
  error?: string;
  onChange: (value: string | boolean) => void;
}) {
  const id = `setting-${field.key.replace(/\./g, '-')}`;
  const wide = field.kind === 'json' || field.kind === 'lines';
  if (field.kind === 'bool') {
    return (
      <div className="flex items-start justify-between gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <div>
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{field.label}</p>
          {field.hint && <p className="text-xs text-zinc-500 dark:text-zinc-400">{field.hint}</p>}
          <p className="mt-0.5 font-mono text-[0.7rem] text-zinc-400">{field.key}</p>
        </div>
        <Toggle label={field.label} checked={value === true} onChange={onChange} />
      </div>
    );
  }
  return (
    <Field
      label={
        <>
          {field.label} <span className="ml-1 font-mono text-[0.7rem] font-normal text-zinc-400">{field.key}</span>
        </>
      }
      htmlFor={id}
      hint={field.hint}
      error={error}
      className={wide ? 'md:col-span-2' : undefined}
    >
      {field.kind === 'select' ? (
        <Select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      ) : field.kind === 'json' || field.kind === 'lines' ? (
        <Textarea
          id={id}
          mono
          rows={field.kind === 'json' ? field.rows ?? 6 : 5}
          value={String(value)}
          placeholder={field.kind === 'lines' ? field.placeholder : undefined}
          aria-invalid={!!error}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          id={id}
          mono={field.kind !== 'text' || field.mono}
          inputMode={field.kind === 'int' || field.kind === 'float' ? 'decimal' : undefined}
          value={String(value)}
          placeholder={field.kind === 'text' ? field.placeholder : undefined}
          aria-invalid={!!error}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

