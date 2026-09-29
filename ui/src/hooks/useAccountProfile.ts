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

const LOCAL_BOARD_ID = "local-board";
const DEFAULT_LOCAL_NAME = "Board";

/**
 * Who is using Automa, for greetings and the account menu. A name or photo you
 * set in Automa wins; otherwise, in the Android app, the Google account signed
 * in on the phone (its name, email and photo); otherwise the server's account;
 * otherwise the local board.
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
    const trimmed = user?.name?.trim() ?? "";
    // The local board starts as "Board"; anything else was set on purpose.
    const sessionName = trimmed && !(user?.id === LOCAL_BOARD_ID && trimmed === DEFAULT_LOCAL_NAME) ? trimmed : null;
    const name = sessionName || google?.name?.trim() || DEFAULT_LOCAL_NAME;
    const source: AccountProfile["source"] = google ? "google" : sessionName ? "session" : "local";
    const localEmail = user?.id === LOCAL_BOARD_ID ? null : user?.email?.trim() || null;
    return {
      name,
      firstName: sessionName || google?.name?.trim() ? name.split(/\s+/)[0] ?? null : null,
      email: google?.email ?? localEmail,
      image: user?.image || google?.photoUrl || null,
      source,
    };
  }, [google?.name, google?.email, google?.photoUrl, user?.id, user?.name, user?.email, user?.image]);
}
