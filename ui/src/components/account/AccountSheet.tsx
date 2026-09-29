import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  Check,
  ChevronRight,
  Loader2,
  LogOut,
  Network,
  Package,
  Plus,
  Server,
  Settings,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { AuthSession, Company, CurrentUserProfile } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { assetsApi } from "@/api/assets";
import { authApi } from "@/api/auth";
import { companiesApi } from "@/api/companies";
import { CompanyPatternIcon } from "@/components/CompanyPatternIcon";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useToastActions } from "@/context/ToastContext";
import { useAccountProfile } from "@/hooks/useAccountProfile";
import { useSignOut } from "@/hooks/useSignOut";
import { automaNative, isAutomaApp } from "@/lib/automa-native";
import { haptic } from "@/lib/haptics";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";

const NAME_MAX = 120;

export function accountInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function PhotoButton({ label, busy, onFile, children }: { label: string; busy: boolean; onFile: (file: File) => void; children: React.ReactNode }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <label htmlFor={inputId} className="relative shrink-0 cursor-pointer rounded-full" aria-label={label} title={label}>
      {children}
      <span className="absolute -right-0.5 -bottom-0.5 flex size-7 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground shadow-sm">
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Camera className="size-3.5" aria-hidden="true" />}
      </span>
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="sr-only"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          if (inputRef.current) inputRef.current.value = "";
        }}
      />
    </label>
  );
}

function ActionRow({ icon: Icon, label, hint, to, onClick, tone }: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  to?: string;
  onClick?: () => void;
  tone?: "danger";
}) {
  const body = (
    <>
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-md bg-accent", tone === "danger" && "bg-destructive/10 text-destructive")}>
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm font-medium", tone === "danger" ? "text-destructive" : "text-foreground")}>{label}</span>
        {hint ? <span className="block truncate text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      {to ? <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
    </>
  );
  const className = "flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-accent/60 active:bg-accent";
  return to ? (
    <Link to={to} onClick={onClick} className={className}>{body}</Link>
  ) : (
    <button type="button" onClick={onClick} className={className}>{body}</button>
  );
}

/**
 * You and your organization, from one tap on your photo: change your name or
 * photo, sign out, change the organization's logo and name, open its
 * structure, artifacts and settings, or switch to another organization.
 */
export function AccountSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToastActions();
  const { openOnboarding } = useDialogActions();
  const { companies, selectedCompany, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const profile = useAccountProfile();
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession(), retry: false });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: open && !!selectedCompanyId,
  });
  const user = session.data?.user ?? null;
  const localBoard = !user || user.id === "local-board";
  const inApp = isAutomaApp();
  const googleSignedIn = profile.source === "google";

  const [name, setName] = useState(profile.name);
  const [orgName, setOrgName] = useState(selectedCompany?.name ?? "");
  useEffect(() => {
    if (!open) return;
    setName(profile.name);
    setOrgName(selectedCompany?.name ?? "");
  }, [open, profile.name, selectedCompany?.name]);

  const done = (title: string) => {
    haptic("success");
    pushToast({ title, tone: "success" });
  };
  const failed = (title: string) => (error: unknown) => {
    haptic("warning");
    pushToast({ title, body: errorText(error), tone: "error" });
  };

  function syncSession(next: CurrentUserProfile) {
    client.setQueryData<AuthSession | null>(queryKeys.auth.session, (current) =>
      current ? { ...current, user: { ...current.user, ...next } } : current,
    );
  }

  const saveName = useMutation({
    mutationFn: () => authApi.updateProfile({ name: name.trim(), image: user?.image ?? null }),
    onSuccess: (next) => {
      syncSession(next);
      done("Name saved");
    },
    onError: failed("Couldn’t save your name"),
  });
  const uploadPhoto = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("Pick an organization first; photos are stored in its files.");
      const asset = await assetsApi.uploadImage(selectedCompanyId, file, `profiles/${user?.id ?? "board-user"}`);
      return authApi.updateProfile({ name: name.trim() || profile.name, image: asset.contentPath });
    },
    onSuccess: (next) => {
      syncSession(next);
      done("Photo updated");
    },
    onError: failed("Couldn’t update your photo"),
  });
  const removePhoto = useMutation({
    mutationFn: () => authApi.updateProfile({ name: name.trim() || profile.name, image: null }),
    onSuccess: (next) => {
      syncSession(next);
      done(googleSignedIn ? "Using your Google photo again" : "Photo removed");
    },
    onError: failed("Couldn’t remove your photo"),
  });

  const refreshCompanies = () => client.invalidateQueries({ queryKey: queryKeys.companies.all });
  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No organization selected.");
      const asset = await assetsApi.uploadCompanyLogo(selectedCompanyId, file);
      return companiesApi.update(selectedCompanyId, { logoAssetId: asset.assetId });
    },
    onSuccess: async () => {
      await refreshCompanies();
      done("Logo updated");
    },
    onError: failed("Couldn’t update the logo"),
  });
  const removeLogo = useMutation({
    mutationFn: () => companiesApi.update(selectedCompanyId!, { logoAssetId: null }),
    onSuccess: async () => {
      await refreshCompanies();
      done("Logo removed");
    },
    onError: failed("Couldn’t remove the logo"),
  });
  const renameOrg = useMutation({
    mutationFn: () => companiesApi.update(selectedCompanyId!, { name: orgName.trim() }),
    onSuccess: async () => {
      await refreshCompanies();
      done("Organization renamed");
    },
    onError: failed("Couldn’t rename the organization"),
  });

  const serverSignOut = useSignOut();
  const signOut = async () => {
    haptic("tick");
    if (!localBoard) {
      try {
        await serverSignOut.mutateAsync();
      } catch (error) {
        failed("Couldn’t sign out")(error);
        return;
      }
    }
    onOpenChange(false);
    if (inApp) {
      automaNative.signOutOfGoogle();
      automaNative.openConnectScreen();
    }
  };

  function switchTo(company: Company) {
    haptic("tick");
    onOpenChange(false);
    if (company.id === selectedCompanyId) return;
    const prefix = location.pathname.split("/")[1]?.toUpperCase();
    const onCompanyRoute = companies.some((item) => item.issuePrefix.toUpperCase() === prefix);
    setSelectedCompanyId(company.id);
    pushToast({ title: `Switched to ${company.name}`, tone: "info" });
    if (onCompanyRoute || location.pathname.startsWith("/instance/")) navigate(`/${company.issuePrefix}/dashboard`);
  }

  const activeAgents = (agents.data ?? []).filter((agent) => agent.status !== "terminated");
  const lead = activeAgents.find((agent) => agent.role === "ceo") ?? activeAgents.find((agent) => !agent.reportsTo);
  const nameChanged = name.trim() !== profile.name && name.trim().length > 0;
  const orgNameChanged = !!selectedCompany && orgName.trim().length > 0 && orgName.trim() !== selectedCompany.name;
  const otherCompanies = companies.filter((company) => company.status !== "archived");
  const close = () => onOpenChange(false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-(--sz-85vh) gap-0 rounded-t-xl p-0 md:inset-x-auto md:left-1/2 md:w-full md:max-w-lg md:-translate-x-1/2" data-testid="account-sheet">
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden="true" />
        <SheetHeader className="sr-only">
          <SheetTitle>You and your organization</SheetTitle>
          <SheetDescription>Your name and photo, sign out, and your organization&apos;s logo, name, and structure</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 pt-3 pb-5">
          <section aria-label="You" className="rounded-xl border border-border bg-card p-3" data-slot="account-profile">
            <div className="flex items-center gap-3">
              <PhotoButton label="Change your photo" busy={uploadPhoto.isPending} onFile={(file) => uploadPhoto.mutate(file)}>
                <Avatar className="size-16 ring-2 ring-border">
                  {profile.image ? <AvatarImage src={profile.image} alt="" referrerPolicy="no-referrer" /> : null}
                  <AvatarFallback className="text-lg">{accountInitials(profile.name)}</AvatarFallback>
                </Avatar>
              </PhotoButton>
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-lg font-semibold leading-tight">{profile.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {profile.email ?? (localBoard ? "This server has no sign-in (local mode)" : "Signed in")}
                </p>
                <span className="mt-1 inline-flex h-5 items-center rounded-full border border-border px-2 text-xs text-muted-foreground">
                  {googleSignedIn ? "Google account" : localBoard ? "Local board" : "Automa account"}
                </span>
              </div>
            </div>
            <form
              className="mt-3 flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (nameChanged && !saveName.isPending) saveName.mutate();
              }}
            >
              <label className="grid min-w-0 flex-1 gap-1 text-xs font-medium text-muted-foreground">
                Your name
                <Input value={name} maxLength={NAME_MAX} onChange={(event) => setName(event.target.value)} autoComplete="name" className="h-10 text-sm text-foreground" />
              </label>
              <Button type="submit" disabled={!nameChanged || saveName.isPending} className="h-10">
                {saveName.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                Save
              </Button>
            </form>
            {user?.image ? (
              <button type="button" onClick={() => removePhoto.mutate()} disabled={removePhoto.isPending} className="mt-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                {googleSignedIn ? "Use my Google photo" : "Remove photo"}
              </button>
            ) : null}
          </section>

          {selectedCompany ? (
            <section aria-label="Organization" className="overflow-hidden rounded-xl border border-border bg-card" data-slot="account-organization">
              <div className="p-3">
                <div className="flex items-center gap-3">
                  <PhotoButton label="Change the organization logo" busy={uploadLogo.isPending} onFile={(file) => uploadLogo.mutate(file)}>
                    <CompanyPatternIcon companyName={selectedCompany.name} logoUrl={selectedCompany.logoUrl} className="size-16 rounded-xl text-xl" />
                  </PhotoButton>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Organization</p>
                    <p className="truncate font-display text-lg font-semibold leading-tight">{selectedCompany.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {activeAgents.length} {activeAgents.length === 1 ? "agent" : "agents"}
                      {lead ? ` · led by ${lead.name}` : ""}
                    </p>
                  </div>
                </div>
                <form
                  className="mt-3 flex items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (orgNameChanged && !renameOrg.isPending) renameOrg.mutate();
                  }}
                >
                  <label className="grid min-w-0 flex-1 gap-1 text-xs font-medium text-muted-foreground">
                    Organization name
                    <Input value={orgName} maxLength={NAME_MAX} onChange={(event) => setOrgName(event.target.value)} autoComplete="organization" className="h-10 text-sm text-foreground" />
                  </label>
                  <Button type="submit" variant="outline" disabled={!orgNameChanged || renameOrg.isPending} className="h-10">
                    {renameOrg.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                    Rename
                  </Button>
                </form>
                {selectedCompany.logoUrl ? (
                  <button type="button" onClick={() => removeLogo.mutate()} disabled={removeLogo.isPending} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                    <Trash2 className="size-3" aria-hidden="true" />
                    Remove logo
                  </button>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">Tap the logo to upload one (PNG, JPG, WebP, or GIF).</p>
                )}
              </div>
              <div className="divide-y divide-border border-t border-border">
                <ActionRow icon={Network} label="Structure" hint="Org chart: who reports to whom" to="/org" onClick={close} />
                <ActionRow icon={Package} label="Artifacts" hint="Files and results your agents made" to="/artifacts" onClick={close} />
                <ActionRow icon={Settings} label="Organization settings" hint="Budgets, approvals, members" to="/company/settings" onClick={close} />
              </div>
            </section>
          ) : null}

          <section aria-labelledby="switch-org-heading" className="flex flex-col gap-2" data-slot="account-switch-organization">
            <h3 id="switch-org-heading" className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Switch organization
            </h3>
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {otherCompanies.map((company) => {
                const current = company.id === selectedCompanyId;
                return (
                  <li key={company.id}>
                    <button
                      type="button"
                      aria-current={current ? "true" : undefined}
                      onClick={() => switchTo(company)}
                      className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-accent/60 active:bg-accent"
                    >
                      <CompanyPatternIcon companyName={company.name} logoUrl={company.logoUrl} className="size-9 rounded-lg text-sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{company.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{current ? "You are here" : company.issuePrefix}</span>
                      </span>
                      {current ? <Check className="size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
                    </button>
                  </li>
                );
              })}
              <li>
                <button
                  type="button"
                  onClick={() => {
                    haptic("tick");
                    onOpenChange(false);
                    openOnboarding({ initialStep: 1 });
                  }}
                  className="flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left text-sm font-medium text-primary transition-colors hover:bg-accent/60"
                >
                  <span className="flex size-9 items-center justify-center rounded-lg border border-dashed border-border">
                    <Plus className="size-4" aria-hidden="true" />
                  </span>
                  New organization
                </button>
              </li>
            </ul>
          </section>

          <section aria-label="Account" className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {inApp ? (
              <ActionRow icon={Server} label="Change server" hint="Connect to another Automa, or this phone" onClick={() => {
                haptic("tick");
                onOpenChange(false);
                automaNative.openConnectScreen();
              }} />
            ) : null}
            {!localBoard || googleSignedIn ? (
              <ActionRow icon={LogOut} label="Sign out" hint={profile.email ?? undefined} tone="danger" onClick={() => void signOut()} />
            ) : null}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Your photo as a button that opens {@link AccountSheet}. */
export function AccountButton({ className, size = "sm" }: { className?: string; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  // Mounted on first open, then kept so it can animate closed.
  const [mounted, setMounted] = useState(false);
  const profile = useAccountProfile();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          haptic("tick");
          setMounted(true);
          setOpen(true);
        }}
        aria-label={`You: ${profile.name}. Profile and organization`}
        data-slot="account-button"
        className={cn("shrink-0 rounded-full transition-transform active:scale-95", className)}
      >
        <Avatar className={cn("ring-2 ring-border", size === "md" ? "size-9" : "size-8")}>
          {profile.image ? <AvatarImage src={profile.image} alt="" referrerPolicy="no-referrer" /> : null}
          <AvatarFallback className="text-xs">{accountInitials(profile.name)}</AvatarFallback>
        </Avatar>
      </button>
      {mounted ? <AccountSheet open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}
