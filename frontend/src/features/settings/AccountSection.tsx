// Settings › Account: your name for the team, automatic approvals, the password of this platform, sign out.

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut } from "lucide-react";
import { changePassword, patchSettings } from "../../api/endpoints";
import { qk } from "../../api/keys";
import type { SettingsPatch } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  Field,
  Input,
  Toggle,
} from "../../components/ui";
import { useToast } from "../../components/toast";
import { useSettings } from "./SettingsForm";

/** Your name for the team, and whether actions wait for your approval or run at once. */
export function YouAndApprovals() {
  const settings = useSettings();
  const client = useQueryClient();
  const { notify } = useToast();
  const [name, setName] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => patchSettings(patch),
    onSuccess: (response, patch) => {
      client.setQueryData(qk.settings, response);
      if ("permissions.mode" in patch) {
        const next = patch["permissions.mode"];
        notify(
          next === "all"
            ? "Your team approves everything, deploys and pushes included"
            : next === "auto"
              ? "Your team no longer waits for your approval, except to deploy, push or send data out"
              : "Your team asks you again before acting",
        );
      } else {
        notify("Your team will call you by this name");
        setName(null);
      }
    },
  });
  if (!settings.data) return null;
  const values = settings.data.values;
  const shown = name ?? values["owner.name"] ?? "";
  const mode = values["permissions.mode"] ?? "ask";
  return (
    <Card>
      <CardHeader title="You and your team" />
      <CardBody className="space-y-4">
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate({ "owner.name": shown.trim() });
          }}
        >
          <Field
            label="Your name"
            htmlFor="owner-name"
            hint="How your team addresses you."
          >
            <Input
              id="owner-name"
              value={shown}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Button
            type="submit"
            size="sm"
            disabled={name === null || save.isPending}
          >
            Save
          </Button>
        </form>
        <div className="space-y-1">
          <Toggle
            checked={mode !== "ask"}
            onChange={(on) =>
              save.mutate({ "permissions.mode": on ? "auto" : "ask" })
            }
            label="Approve actions automatically"
            showLabel
            disabled={save.isPending}
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Like Claude Code's bypass mode. Private folders and secrets stay
            closed.
          </p>
        </div>
        {mode !== "ask" && (
          <div className="space-y-1">
            <Toggle
              checked={mode === "all"}
              onChange={(on) =>
                save.mutate({ "permissions.mode": on ? "all" : "auto" })
              }
              label="Also deploys, pushes and sending data out"
              showLabel
              disabled={save.isPending}
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {mode === "all"
                ? "Nothing waits for you: deploying, git push and sending data out run too."
                : "Off: your team still asks before deploying, pushing code or sending data out."}
            </p>
          </div>
        )}
        {save.isError && (
          <ErrorState compact error={save.error} title="Not changed." />
        )}
      </CardBody>
    </Card>
  );
}

export function AccountSection() {
  const { username, signOut, sessionEnded } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: () =>
      changePassword({ current_password: current, new_password: next }),
    onSuccess: () => sessionEnded(),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (next.length < 10)
      return setError("The new password needs at least 10 characters.");
    if (next !== confirm)
      return setError(
        "The two new passwords are different. Type the same one twice.",
      );
    setError(null);
    change.mutate();
  }
  return (
    <div className="space-y-4">
      <YouAndApprovals />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Change your password"
            description="For this platform, not your Claude password. You then sign in again."
          />
          <CardBody>
            <form onSubmit={submit} className="space-y-3">
              <input
                type="text"
                autoComplete="username"
                value={username ?? ""}
                readOnly
                hidden
              />
              <Field label="Current password" htmlFor="pw-current">
                <Input
                  id="pw-current"
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                />
              </Field>
              <Field
                label="New password"
                htmlFor="pw-new"
                hint="At least 10 characters."
              >
                <Input
                  id="pw-new"
                  type="password"
                  autoComplete="new-password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                />
              </Field>
              <Field label="New password again" htmlFor="pw-confirm">
                <Input
                  id="pw-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </Field>
              {error && (
                <p
                  className="text-xs text-red-700 dark:text-red-400"
                  role="alert"
                >
                  {error}
                </p>
              )}
              {change.isError && (
                <ErrorState
                  compact
                  error={change.error}
                  title="Your password was not changed."
                />
              )}
              <Button
                type="submit"
                variant="primary"
                icon={<KeyRound className="h-4 w-4" />}
                loading={change.isPending}
                disabled={!current || !next}
              >
                Change password
              </Button>
            </form>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Signed in" />
          <CardBody className="space-y-3">
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              You are signed in as{" "}
              <span className="font-medium">{username}</span>.
            </p>
            <Button
              icon={<LogOut className="h-4 w-4" />}
              onClick={() => void signOut()}
            >
              Sign out
            </Button>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
