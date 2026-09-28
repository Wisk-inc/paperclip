import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { automaNative } from "@/lib/automa-native";
import { queryKeys } from "@/lib/queryKeys";

export interface AccountProfile {
  name: string;
  firstName: string | null;
  email: string | null;
  /** Profile photo URL (the Google account photo when signed in with Google). */
  image: string | null;
  /** `google`: the account signed in on this phone; `session`: the server account; `local`: no account (local board). */
  source: "google" | "session" | "local";
}

/**
 * Who is using Automa, for greetings and the account menu. In the Android app
 * the Google account signed in on the phone wins (its name, email and photo);
 * otherwise the server's signed-in account; otherwise the local board.
 */
export function useAccountProfile(): AccountProfile {
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const google = automaNative.account()?.user ?? null;
  const user = session.data?.user;
  return useMemo(() => {
    const sessionName = user?.name?.trim() && user.id !== "local-board" ? user.name.trim() : null;
    const name = google?.name?.trim() || sessionName || "Board";
    const source: AccountProfile["source"] = google ? "google" : sessionName ? "session" : "local";
    return {
      name,
      firstName: source === "local" ? null : name.split(/\s+/)[0] ?? null,
      email: google?.email ?? user?.email?.trim() ?? null,
      image: google?.photoUrl ?? user?.image ?? null,
      source,
    };
  }, [google?.name, google?.email, google?.photoUrl, user?.id, user?.name, user?.email, user?.image]);
}
