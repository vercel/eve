import {
  applyConversationPatch,
  compareChatMessages,
  messageSegments,
  toolLabel,
} from "../../packages/protocol/src/conversation";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Alert,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  TextInput,
  View,
  StatusBar,
  type TextProps,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useFonts } from "expo-font";
import Svg, { Path } from "react-native-svg";
import Markdown from "react-native-markdown-display";
import EventSource from "react-native-sse";
import { WebView } from "react-native-webview";
import {
  parsePair as parsePairInput,
  isPairLink,
  editPairCode,
  redeemPair,
  type Pair,
  type PairedDevice,
} from "./pairing";
import * as SecureStore from "expo-secure-store";
import * as Notifications from "expo-notifications";
import * as Crypto from "expo-crypto";
import Constants, { ExecutionEnvironment } from "expo-constants";

type Session = {
  agentId: string;
  name: string;
  deviceToken: string;
  relay: string;
  bypassToken?: string;
};
type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools?: { id: string; name: string; status: string; offset: number }[];
  createdAt: number;
  updatedAt?: number;
  status?: "sending" | "failed" | "streaming" | "error";
};
type RemoteDesktop = { state: string; sandboxName?: string; driveName?: string; error?: string };
type State = {
  asOf?: number;
  model?: string | null;
  activeResponse?: string | null;
  cloudAvailable?: boolean;
  streams?: Message[];
  remoteDesktop?: RemoteDesktop;
  name: string;
  browserReady: boolean;
  messages: Message[];
};
const parsePair = (input: string) => parsePairInput(input, { relay: "" });
const indexKey = "eve.session-index";
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
if (!isExpoGo)
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
async function api<T>(
  relay: string,
  path: string,
  token?: string,
  body?: unknown,
  method = body ? "POST" : "GET",
  bypassToken?: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bypassToken) headers["x-vercel-protection-bypass"] = bypassToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetch(`${relay}/v1/${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw Error(
        response.status === 401 || response.status === 403
          ? "This deployment is protected. Run ./scripts/setup.sh in the agent project to configure its bypass tokens, redeploy, then pair again."
          : "The app did not respond correctly. Try again in a moment.",
      );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}
async function saveSessions(sessions: Session[]) {
  for (const session of sessions)
    await SecureStore.setItemAsync(`eve.session.${session.agentId}`, JSON.stringify(session));
  await SecureStore.setItemAsync(indexKey, JSON.stringify(sessions.map((s) => s.agentId)));
}
function Text(props: TextProps) {
  return <NativeText {...props} style={[{ fontFamily: "Geist" }, props.style]} />;
}
function EveLogo({ wide = false, size = 20 }: { wide?: boolean; size?: number }) {
  return (
    <Svg
      width={wide ? size * 3.22 : size * 1.19}
      height={size}
      viewBox={wide ? "0 0 52 16" : "0 0 19 16"}
      accessibilityLabel="eve"
    >
      <Path
        fill="#ededed"
        d={
          wide
            ? "M51.02 2.56H35.5L24.67 16h-3.43L34.12 0h16.9zM51.02 13.44v2.55H37.17v-2.55zM13.85 16H0v-2.56h13.85zM11.67 9.22H0V6.67h11.67zM51.02 9.22H39.35V6.67h11.67zM22.8 2.56H0V0h22.8z"
            : "M19 3h-4.42L3.95 16H.08L13.16 0H19zm0 13h-8v-3h8zM4 9.5H0v-3h4zm15 0h-4v-3h4zM8 3H0V0h8z"
        }
      />
    </Svg>
  );
}
function Action({
  label,
  onPress,
  secondary,
  disabled,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, secondary && styles.secondary, disabled && { opacity: 0.45 }]}
    >
      <Text style={[styles.buttonText, secondary && { color: "#ededed" }]}>{label}</Text>
    </Pressable>
  );
}
function MessageText({ text, markdown = false }: { text: string; markdown?: boolean }) {
  if (markdown)
    return (
      <Markdown
        style={markdownStyles}
        rules={{ image: () => null }}
        onLinkPress={(url) => {
          if (/^(https?:|mailto:)/.test(url)) void Linking.openURL(url);
          return false;
        }}
      >
        {text}
      </Markdown>
    );
  return (
    <Text selectable style={styles.messageText}>
      {text}
    </Text>
  );
}
function BlinkingCursor() {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(550),
        Animated.timing(opacity, { toValue: 0, duration: 0, useNativeDriver: true }),
        Animated.delay(550),
        Animated.timing(opacity, { toValue: 1, duration: 0, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);
  return (
    <Animated.Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[{ fontFamily: "GeistMono", fontSize: 16, color: "#ededed" }, { opacity }]}
    >
      ▍
    </Animated.Text>
  );
}
function ToolActivity({ name, status }: { name: string; status: string }) {
  const [expanded, setExpanded] = useState(false);
  const working = status === "preparing" || status === "running";
  return (
    <Pressable
      onPress={() => setExpanded(!expanded)}
      accessibilityRole="button"
      accessibilityLabel={`${toolLabel(name)}: ${status}`}
      accessibilityState={{ expanded }}
      style={styles.toolActivity}
    >
      <View style={styles.toolRow}>
        {working ? (
          <ActivityIndicator size="small" color="#999" />
        ) : (
          <Text style={styles.toolIcon}>{status === "completed" ? "✓" : "×"}</Text>
        )}
        <Text style={styles.toolLabel}>{toolLabel(name)}</Text>
        <Text style={styles.toolStatus}>
          {status === "completed"
            ? "Done"
            : status === "failed"
              ? "Failed"
              : status === "interrupted"
                ? "Interrupted"
                : status === "preparing"
                  ? "Preparing"
                  : "Running"}
        </Text>
      </View>
      {expanded && <Text style={styles.toolName}>{name}</Text>}
    </Pressable>
  );
}
const MessageRow = React.memo(function MessageRow({
  item,
  focused,
  onRetry,
}: {
  item: Message;
  focused: boolean;
  onRetry: (item: Message) => void;
}) {
  return (
    <View
      style={[
        styles.bubble,
        item.role === "user" ? styles.userBubble : styles.agentBubble,
        focused && styles.highlight,
      ]}
    >
      {item.role === "assistant" && <Text style={styles.messageRole}>eve</Text>}
      {item.role === "assistant" && (item.text || item.tools?.length) ? (
        messageSegments(item).map((segment, index) =>
          segment.type === "tool" ? (
            <ToolActivity key={segment.id} name={segment.name} status={segment.status} />
          ) : (
            <MessageText key={`text-${index}`} text={segment.text} markdown />
          ),
        )
      ) : (
        <MessageText
          text={item.text || (item.status === "error" ? "Reply interrupted." : "Thinking…")}
          markdown={item.role === "assistant"}
        />
      )}
      {item.status === "streaming" && <BlinkingCursor />}
      {item.status === "sending" && <Text style={styles.fine}>Sending…</Text>}
      {item.status === "error" && (
        <Text style={styles.fine}>Partial response · connection interrupted</Text>
      )}
      {item.status === "failed" && (
        <Pressable onPress={() => onRetry(item)}>
          <Text style={styles.retry}>Not sent · Retry ↗</Text>
        </Pressable>
      )}
    </View>
  );
});
function EveApp() {
  const [sessions, setSessions] = useState<Session[]>([]),
    [selected, setSelected] = useState<string>();
  const codeKey = useRef<string | undefined>(undefined);
  const codeCursor = useRef({ start: 0, end: 0 });
  const [codeSelection, setCodeSelection] = useState({ start: 0, end: 0 });
  const [ready, setReady] = useState(false),
    [pairing, setPairing] = useState(false);
  const [pair, setPair] = useState<Pair>(),
    [link, setLink] = useState(""),
    [busy, setBusy] = useState(false);
  const [state, setState] = useState<State>(),
    [error, setError] = useState(""),
    [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false),
    [notificationBusy, setNotificationBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [browserVisible, setBrowserVisible] = useState(false);
  const initialScrollPending = useRef(true);
  const [pendingMessages, setPendingMessages] = useState<Message[]>([]);
  const followTail = useRef(true);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [focusedMessage, setFocusedMessage] = useState<string>();
  const sendRef = useRef<(item: Message) => Promise<void>>(async () => {});
  const retryMessageSend = useCallback((item: Message) => {
    void sendRef.current(item);
  }, []);
  sendRef.current = send;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const pendingNotification = useRef<{ agentId?: string; messageId?: string } | null>(null);
  const retryMessage = useRef<{ id: string; text: string } | null>(null);
  const list = useRef<FlatList<Message>>(null);
  const session = sessions.find((s) => s.agentId === selected);
  const confirmed = new Set(state?.messages.map((m) => m.id));
  const chatMessages = [
    ...(state?.messages || []),
    ...(state?.streams || []).filter((m) => !confirmed.has(m.id)),
    ...pendingMessages.filter((m) => !confirmed.has(m.id)),
  ].sort((a, b) => compareChatMessages(b, a));
  function computerApi<T>(
    path: string,
    body?: unknown,
    method = body ? "POST" : "GET",
  ): Promise<T> {
    const origin = session?.relay;
    if (!session || !origin)
      return Promise.reject(Error("The agent endpoint is not connected yet."));
    return api<T>(origin, path, session.deviceToken, body, method, session.bypassToken);
  }

  useEffect(() => {
    let alive = true;
    if (!browserVisible || !session || !state?.browserReady) {
      setPreviewUrl(undefined);
      return;
    }
    if (previewUrl) return;
    void computerApi<{ url?: string }>("mobile/desktop/link", {}, "POST")
      .then((result) => {
        if (alive && result.url) {
          const url = new URL(result.url);
          if (url.protocol === "https:" && url.hostname.endsWith(".vercel.run")) {
            url.searchParams.set("preview", "1");
            setPreviewUrl(url.href);
          }
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [browserVisible, session?.agentId, state?.browserReady, previewUrl]);
  const openNotification = useCallback((data: { agentId?: string; messageId?: string }) => {
    if (!data.agentId) return;
    if (sessionsRef.current.some((s) => s.agentId === data.agentId)) {
      setSelected(data.agentId);
      setFocusedMessage(data.messageId);
      setPairing(false);
    } else pendingNotification.current = data;
  }, []);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const ids: string[] = JSON.parse((await SecureStore.getItemAsync(indexKey)) || "[]");
        const stored = (
          await Promise.all(ids.map((id) => SecureStore.getItemAsync(`eve.session.${id}`)))
        )
          .filter(Boolean)
          .map((value) => JSON.parse(value!) as Session);
        await saveSessions(stored);
        if (alive) {
          sessionsRef.current = stored;
          setSessions(stored);
        }
        if (!isExpoGo) {
          const notification = await Notifications.getLastNotificationResponseAsync();
          if (notification) openNotification(notification.notification.request.content.data || {});
        }
      } catch {
        if (alive) setError("Could not load saved connections.");
      } finally {
        if (alive) setReady(true);
      }
    })();
    const receive = (url: string) => {
      if (!isPairLink(url)) return;
      try {
        setPair(parsePair(url));
        setPairing(true);
      } catch (e) {
        Alert.alert("Pairing link", (e as Error).message);
      }
    };
    void Linking.getInitialURL().then((url) => {
      if (url) receive(url);
    });
    const subscription = Linking.addEventListener("url", (e) => receive(e.url));
    const notifications = isExpoGo
      ? undefined
      : Notifications.addNotificationResponseReceivedListener((response) =>
          openNotification(response.notification.request.content.data || {}),
        );
    return () => {
      alive = false;
      subscription.remove();
      notifications?.remove();
    };
  }, [openNotification]);
  useEffect(() => {
    if (
      pendingNotification.current &&
      sessions.some((s) => s.agentId === pendingNotification.current?.agentId)
    ) {
      const pending = pendingNotification.current;
      pendingNotification.current = null;
      openNotification(pending);
    }
  }, [sessions, openNotification]);
  useEffect(() => {
    followTail.current = true;
    initialScrollPending.current = true;
    setBrowserVisible(false);
    setState(undefined);
    setPreviewUrl(undefined);
    setError("");
    setDraft("");
    setPendingMessages([]);
    retryMessage.current = null;
    if (!session) return;
    let alive = true,
      timer: ReturnType<typeof setTimeout>,
      active = AppState.currentState === "active",
      streamActivity = 0;
    async function refresh() {
      if (!alive) return;
      if (active) {
        try {
          const next = await api<State>(
            session!.relay,
            "mobile/state",
            session!.deviceToken,
            undefined,
            "GET",
            session!.bypassToken,
          );
          if (alive) {
            setState((previous) =>
              previous &&
              ((streamActivity && Date.now() - streamActivity < 15000) ||
                (previous.asOf || 0) > (next.asOf || 0))
                ? {
                    ...next,
                    messages: previous.messages,
                    streams: previous.streams,
                    asOf: previous.asOf,
                    model: previous.model,
                    activeResponse: previous.activeResponse,
                  }
                : next,
            );
            setPendingMessages((previous) =>
              previous.filter((m) => !next.messages.some((server) => server.id === m.id)),
            );
            setError("");
          }
        } catch (e) {
          if (alive) setError((e as Error).message);
        }
      }
      if (alive) timer = setTimeout(refresh, 2500);
    }
    void refresh();
    let source: EventSource<"conversation" | "conversation.patch" | "heartbeat"> | undefined;
    function startStream() {
      if (source || !active) return;
      const headers: Record<string, string> = { Authorization: `Bearer ${session!.deviceToken}` };
      if (session!.bypassToken) headers["x-vercel-protection-bypass"] = session!.bypassToken;
      source = new EventSource<"conversation" | "conversation.patch" | "heartbeat">(
        `${session!.relay}/v1/mobile/events?v=2`,
        {
          headers,
          pollingInterval: 1000,
        },
      );
      const receive = (data: string | null | undefined, patch = false) => {
        if (!alive || !data) return;
        try {
          const chat = JSON.parse(data);
          streamActivity = Date.now();
          setState((previous) => {
            const base = previous || {
              name: session!.name,
              browserReady: false,
              messages: [],
              streams: [],
            };
            const next = patch
              ? applyConversationPatch(
                  { asOf: base.asOf || 0, messages: base.messages, streams: base.streams || [] },
                  chat,
                )
              : chat;
            return { ...base, ...next };
          });
          setPendingMessages((previous) =>
            previous.filter((m) => !chat.messages.some((server: Message) => server.id === m.id)),
          );
        } catch {}
      };
      source.addEventListener("conversation", (event) => receive(event.data));
      source.addEventListener("conversation.patch", (event) => receive(event.data, true));
      source.addEventListener("heartbeat", () => {
        streamActivity = Date.now();
      });
      source.addEventListener("error", () => {
        streamActivity = 0;
      });
    }
    startStream();
    const subscription = AppState.addEventListener("change", (value) => {
      active = value === "active";
      if (active) startStream();
      else {
        source?.close();
        source = undefined;
        streamActivity = 0;
      }
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      source?.close();
      subscription.remove();
    };
  }, [session?.agentId, session?.deviceToken]);
  useEffect(() => {
    if (!state?.messages.length) return;
    const index = chatMessages.findIndex((m) => m.id === focusedMessage);
    const timer = setTimeout(() => {
      if (index >= 0) list.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 });
      else if (initialScrollPending.current || followTail.current)
        list.current?.scrollToOffset({ offset: 0, animated: !initialScrollPending.current });
    }, 100);
    return () => clearTimeout(timer);
  }, [
    state?.messages.length,
    state?.streams?.at(-1)?.updatedAt,
    pendingMessages.length,
    focusedMessage,
  ]);
  async function connect(candidate = pair) {
    if (!candidate) return;
    setBusy(true);
    try {
      const result = await redeemPair(candidate, (direct) =>
        api<PairedDevice>(
          direct.relay,
          "pair",
          undefined,
          { pairingToken: direct.token },
          "POST",
          direct.bypassToken,
        ),
      );
      const next = [...sessions.filter((s) => s.agentId !== result.agentId), result];
      await saveSessions(next);
      setSessions(next);
      setSelected(result.agentId);
      setPair(undefined);
      setPairing(false);
      setLink("");
      codeCursor.current = { start: 0, end: 0 };
      setCodeSelection(codeCursor.current);
    } catch (e) {
      Alert.alert("Could not connect", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function send(existing?: Message) {
    if (!session || sending || (!existing && !draft.trim())) return;
    const message: Message = existing || {
      id: Crypto.randomUUID(),
      text: draft.trim(),
      role: "user",
      createdAt: Date.now(),
    };
    if (!existing) setDraft("");
    followTail.current = true;
    setSending(true);
    setFocusedMessage(undefined);
    setPendingMessages((previous) => [
      ...previous.filter((m) => m.id !== message.id),
      { ...message, status: "sending" },
    ]);
    try {
      await api(
        session.relay,
        "mobile/messages",
        session.deviceToken,
        { id: message.id, text: message.text },
        "POST",
        session.bypassToken,
      );
      setPendingMessages((previous) =>
        previous.map((m) => (m.id === message.id ? { ...m, status: undefined } : m)),
      );
    } catch {
      setPendingMessages((previous) =>
        previous.map((m) => (m.id === message.id ? { ...m, status: "failed" } : m)),
      );
    } finally {
      setSending(false);
    }
  }
  async function stopResponse() {
    if (!state?.activeResponse || stopping) return;
    const id = state.activeResponse;
    setStopping(true);
    try {
      await computerApi("mobile/stop", { id }, "POST");
    } catch (error) {
      Alert.alert("Could not stop response", (error as Error).message);
    } finally {
      setStopping(false);
    }
  }
  async function notifications() {
    if (isExpoGo) {
      Alert.alert(
        "Expo Go preview",
        "Chat and proactive alerts work while this app is open. Install the eve Start build to receive push notifications when the app is closed.",
      );
      return;
    }
    if (!session) return;
    setNotificationBusy(true);
    try {
      if (Platform.OS === "android")
        await Notifications.setNotificationChannelAsync("default", {
          name: "eve alerts",
          importance: Notifications.AndroidImportance.HIGH,
        });
      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
      if (!projectId)
        throw new Error(
          "Configure EXPO_PUBLIC_EAS_PROJECT_ID and create an eve Start development build first.",
        );
      if ((await Notifications.requestPermissionsAsync()).status !== "granted")
        throw new Error("Enable notifications for eve Start in your phone settings.");
      const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      await api(
        session.relay,
        "mobile/push",
        session.deviceToken,
        { pushToken: token },
        "PUT",
        session.bypassToken,
      );
      Alert.alert(
        "Notifications enabled",
        "eve can now alert you when something needs your attention.",
      );
    } catch (e) {
      Alert.alert("Notifications", (e as Error).message);
    } finally {
      setNotificationBusy(false);
    }
  }
  async function openDesktop() {
    if (!session || desktopBusy) return;
    setDesktopBusy(true);
    try {
      const request = <T,>(path: string, body?: unknown, method = body ? "POST" : "GET") =>
        computerApi<T>(path, body, method);
      let status = await request<RemoteDesktop>("mobile/desktop");
      if (status.state !== "ready") {
        await request("mobile/desktop", {});
        for (let i = 0; i < 180; i++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          status = await request<RemoteDesktop>("mobile/desktop");
          if (status.state === "error")
            throw new Error(status.error || "Remote browser could not start");
          if (status.state === "ready") break;
        }
      }
      if (status.state !== "ready")
        throw new Error("The browser is still starting. Try opening it again shortly.");
      const desktop = await request<{ url?: string }>("mobile/desktop/link", {});
      if (!desktop.url || !desktop.url.startsWith("https://"))
        throw new Error("Desktop is not ready yet");
      await Linking.openURL(desktop.url);
    } catch (e) {
      Alert.alert("Remote browser", (e as Error).message);
    } finally {
      setDesktopBusy(false);
    }
  }
  async function stopDesktop() {
    if (!session || desktopBusy) return;
    setDesktopBusy(true);
    try {
      await computerApi("mobile/desktop", undefined, "DELETE");
    } catch (e) {
      Alert.alert("Remote browser", (e as Error).message);
    } finally {
      setDesktopBusy(false);
    }
  }
  function disconnect() {
    if (!session) return;
    Alert.alert(
      "Disconnect agent?",
      "This removes this phone’s connection. The agent and desktop keep running.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await api(
                  session.relay,
                  "mobile/session",
                  session.deviceToken,
                  undefined,
                  "DELETE",
                  session.bypassToken,
                );
                const next = sessions.filter((s) => s.agentId !== session.agentId);
                await saveSessions(next);
                await SecureStore.deleteItemAsync(`eve.session.${session.agentId}`);
                setSessions(next);
                setSelected(undefined);
              } catch (e) {
                Alert.alert("Could not disconnect", (e as Error).message);
              }
            })();
          },
        },
      ],
    );
  }
  if (!ready)
    return (
      <SafeAreaView style={styles.screen}>
        <ActivityIndicator color="#ededed" style={{ flex: 1 }} />
      </SafeAreaView>
    );
  if (pairing || (!session && sessions.length === 0))
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          {sessions.length > 0 && (
            <Pressable
              onPress={() => {
                setPairing(false);
              }}
            >
              <Text style={styles.back}>← Back</Text>
            </Pressable>
          )}
          <View style={styles.brand}>
            <EveLogo wide size={19} />
            <Text style={styles.tag}>/ start</Text>
          </View>
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.body, { paddingBottom: 40 }]}
        >
          <Text style={styles.title}>Join shared app</Text>
          <Text style={styles.subtitle}>
            {pair
              ? "Review the agent address below, then confirm the connection."
              : "Scan the Expo Go QR in your agent’s web dashboard, or paste its private pairing link."}
          </Text>
          <TextInput
            value={link}
            selection={codeSelection}
            onKeyPress={(event) => {
              codeKey.current = event.nativeEvent.key;
            }}
            onSelectionChange={(event) => {
              codeCursor.current = event.nativeEvent.selection;
            }}
            onChangeText={(next) => {
              const edit = editPairCode(link, next, codeCursor.current, codeKey.current);
              codeKey.current = undefined;
              codeCursor.current = edit.selection;
              setCodeSelection(edit.selection);
              setLink(edit.text);
            }}
            placeholder="eve-go://pair?…"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            accessibilityLabel="Pairing link or code"
            returnKeyType="go"
            onSubmitEditing={() => {
              try {
                void connect(parsePair(link));
              } catch (e) {
                Alert.alert("Invalid code", (e as Error).message);
              }
            }}
          />
          <Action
            label={busy ? "Connecting…" : "Connect agent"}
            disabled={busy || !link.trim()}
            onPress={() => {
              try {
                void connect(parsePair(link));
              } catch (e) {
                Alert.alert("Invalid code", (e as Error).message);
              }
            }}
          />
          {pair && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Connect to this app?</Text>
              <Text selectable style={styles.subtitle}>
                {pair.relay}
              </Text>
              <Action
                label={busy ? "Connecting…" : "Connect agent"}
                disabled={busy}
                onPress={() => void connect()}
              />
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  if (!session)
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <EveLogo wide size={19} />
            <Text style={styles.tag}>/ start</Text>
          </View>
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.body, { paddingBottom: 40 }]}
        >
          {" "}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {sessions.length > 0 && <Text style={styles.label}>Agents</Text>}
          {sessions.map((s) => (
            <Pressable
              key={s.agentId}
              style={styles.agentCard}
              onPress={() => setSelected(s.agentId)}
            >
              <View style={styles.avatar}>
                <EveLogo size={17} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{s.name}</Text>
                <Text numberOfLines={1} style={styles.fine}>
                  {s.relay}
                </Text>
              </View>
              <Text style={styles.back}>↗</Text>
            </Pressable>
          ))}
          <Action label="+ Connect an agent" secondary onPress={() => setPairing(true)} />
        </ScrollView>
      </SafeAreaView>
    );
  const online = Boolean(state?.browserReady);
  const browserStatus = !state
    ? "Connecting…"
    : state.cloudAvailable === false
      ? "Not configured"
      : online
        ? "Ready"
        : state.remoteDesktop?.state === "starting"
          ? "Starting"
          : "Sleeping · wakes when needed";

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.chatHeader}>
          <Pressable accessibilityLabel="All agents" onPress={() => setSelected(undefined)}>
            <Text style={styles.back}>←</Text>
          </Pressable>
          <View style={styles.avatar}>
            <EveLogo size={17} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>{state?.name || session.name}</Text>
            <Text style={styles.fine}>
              <Text style={{ color: online ? "#79d49a" : "#777777" }}>● </Text>
              Browser · {browserStatus}
            </Text>
          </View>
          <Pressable accessibilityLabel="Disconnect agent" onPress={disconnect}>
            <Text style={styles.fine}>Disconnect</Text>
          </Pressable>
        </View>
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error} · Retrying…
          </Text>
        ) : null}
        {!isExpoGo && (
          <Pressable
            disabled={notificationBusy}
            style={styles.notificationBar}
            onPress={() => void notifications()}
          >
            <Text style={styles.notificationText}>
              {isExpoGo
                ? "Expo Go · in-app alerts"
                : notificationBusy
                  ? "Setting up notifications…"
                  : "↗ Enable push notifications"}
            </Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={browserVisible ? "Hide browser" : "Show browser"}
          accessibilityState={{ expanded: browserVisible }}
          onPress={() => {
            setBrowserVisible((value) => !value);
          }}
          style={styles.browserToggle}
        >
          <Text style={styles.browserToggleText}>
            {browserVisible ? "▾ Hide browser" : "▸ Show browser"}
          </Text>
        </Pressable>
        {browserVisible && (
          <>
            <View style={styles.browserPanel}>
              {state?.cloudAvailable === false && (
                <Text style={styles.localNote}>
                  Run ./scripts/setup.sh to enable the cloud browser.
                </Text>
              )}
              {state?.cloudAvailable !== false && (
                <Pressable
                  accessibilityRole="button"
                  disabled={desktopBusy}
                  onPress={() => void openDesktop()}
                  style={styles.desktopLink}
                >
                  <Text style={styles.notificationText}>
                    {desktopBusy ? "Connecting…" : "Open full browser ↗"}
                  </Text>
                </Pressable>
              )}
              {state?.remoteDesktop?.state === "ready" && (
                <Pressable disabled={desktopBusy} onPress={() => void stopDesktop()}>
                  <Text style={styles.fine}>Stop</Text>
                </Pressable>
              )}
            </View>
            {state?.cloudAvailable !== false && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open full cloud browser"
                onPress={() => void openDesktop()}
                style={styles.browserPreview}
              >
                <View style={styles.previewHeader}>
                  <Text style={styles.previewLabel}>{online ? "Live" : "Sleeping"}</Text>
                  <Text style={styles.previewLabel}>Open browser ↗</Text>
                </View>
                <View pointerEvents="none" style={styles.previewViewport}>
                  {previewUrl ? (
                    <WebView
                      source={{ uri: previewUrl }}
                      originWhitelist={["https://*"]}
                      onShouldStartLoadWithRequest={(request) =>
                        request.url === "about:blank" ||
                        /^https:\/\/[^/]+\.vercel\.run\//.test(request.url)
                      }
                      scrollEnabled={false}
                      bounces={false}
                      sharedCookiesEnabled={true}
                      style={{ backgroundColor: "#050505", flex: 1 }}
                      onHttpError={() => setPreviewUrl(undefined)}
                      onError={() => setPreviewUrl(undefined)}
                      onMessage={(event) => {
                        try {
                          if (JSON.parse(event.nativeEvent.data).type === "desktop-disconnected")
                            setPreviewUrl(undefined);
                        } catch {}
                      }}
                    />
                  ) : (
                    <View style={styles.previewPlaceholder}>
                      <Text style={styles.fine}>
                        {desktopBusy
                          ? "Starting browser…"
                          : online
                            ? "Connecting to live browser…"
                            : "Tap to start the browser."}
                      </Text>
                    </View>
                  )}
                </View>
              </Pressable>
            )}
          </>
        )}
        <FlatList
          key={session.agentId}
          ref={list}
          inverted
          data={chatMessages}
          maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.messages}
          onLayout={() => {
            if ((initialScrollPending.current || followTail.current) && !focusedMessage)
              list.current?.scrollToOffset({ offset: 0, animated: false });
          }}
          onContentSizeChange={() => {
            if (!focusedMessage && (initialScrollPending.current || followTail.current))
              list.current?.scrollToOffset({ offset: 0, animated: !initialScrollPending.current });
          }}
          scrollEventThrottle={100}
          onScrollBeginDrag={() => {
            initialScrollPending.current = false;
            followTail.current = false;
          }}
          onScroll={(event) => {
            if (initialScrollPending.current) return;
            const { contentOffset } = event.nativeEvent;
            followTail.current = contentOffset.y < 80;
          }}
          onScrollToIndexFailed={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
          ListEmptyComponent={
            <View style={styles.empty}>
              <EveLogo size={34} />
              <Text style={styles.emptyTitle}>What are we building?</Text>
            </View>
          }
          renderItem={({ item }) => (
            <MessageRow
              item={item}
              focused={item.id === focusedMessage}
              onRetry={retryMessageSend}
            />
          )}
        />
        <View style={styles.composer}>
          <TextInput
            accessibilityLabel="Message your agent"
            placeholder="Message eve…"
            placeholderTextColor="#666"
            value={draft}
            onChangeText={setDraft}
            multiline
            maxLength={10000}
            style={styles.draft}
            editable={true}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={state?.activeResponse ? "Stop response" : "Send message"}
            accessibilityState={{
              disabled: state?.activeResponse ? stopping : !draft.trim() || sending,
              busy: state?.activeResponse ? stopping : sending,
            }}
            disabled={state?.activeResponse ? stopping : !draft.trim() || sending}
            style={[
              styles.send,
              (state?.activeResponse ? stopping : !draft.trim() || sending) && { opacity: 0.4 },
            ]}
            onPress={() => (state?.activeResponse ? void stopResponse() : void send())}
          >
            <Text style={styles.sendText}>{state?.activeResponse ? "■" : sending ? "…" : "↑"}</Text>
          </Pressable>
        </View>
        <Text style={styles.composerFoot}>{state?.model || "eve Start"}</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    Geist: require("./assets/Geist.ttf"),
    GeistMono: require("./assets/GeistMono.ttf"),
  });
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      {fontsLoaded || fontError ? (
        <EveApp />
      ) : (
        <SafeAreaView style={{ flex: 1, backgroundColor: "#0a0a0a", justifyContent: "center" }}>
          <ActivityIndicator color="#ededed" />
        </SafeAreaView>
      )}
    </SafeAreaProvider>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0a0a0a" },
  header: {
    padding: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brand: { flexDirection: "row", gap: 10, alignItems: "center" },
  wordmark: { fontSize: 28, color: "#ededed" },
  tag: { fontSize: 13, color: "#777" },
  body: { paddingHorizontal: 26, paddingTop: 28, gap: 19 },
  eyebrow: { fontSize: 13, color: "#777" },
  title: { fontSize: 43, lineHeight: 48, letterSpacing: -1.8, fontWeight: "500", color: "#ededed" },
  subtitle: { fontSize: 15, lineHeight: 25, color: "#888" },
  orb: { width: 68, height: 68, alignItems: "center", justifyContent: "center", marginBottom: 9 },
  orbText: { color: "#ededed" },
  button: { backgroundColor: "#ededed", borderRadius: 7, padding: 16, alignItems: "center" },
  secondary: { backgroundColor: "#191919", borderWidth: 1, borderColor: "#333" },
  buttonText: { color: "#111", fontSize: 14, fontWeight: "600" },
  label: { fontSize: 13, color: "#777", marginTop: 15 },
  input: {
    borderWidth: 1,
    borderColor: "#333",
    borderRadius: 7,
    padding: 14,
    color: "#ededed",
    backgroundColor: "#111",
    fontFamily: "GeistMono",
    fontSize: 14,
  },
  card: {
    padding: 18,
    borderRadius: 8,
    backgroundColor: "#151515",
    borderWidth: 1,
    borderColor: "#2a2a2a",
    gap: 12,
  },
  cardTitle: { fontSize: 15, fontWeight: "500", color: "#ededed" },
  toolActivity: { paddingVertical: 8 },
  toolRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  toolIcon: { color: "#999", width: 20, textAlign: "center" },
  toolLabel: { fontFamily: "GeistMono", fontSize: 13, color: "#aaa", flex: 1 },
  toolStatus: { fontSize: 13, color: "#666" },
  toolName: {
    fontFamily: "GeistMono",
    fontSize: 13,
    color: "#666",
    paddingLeft: 29,
    paddingTop: 5,
  },
  fine: { fontSize: 14, lineHeight: 16, color: "#777" },
  agentCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 17,
    backgroundColor: "#141414",
    borderWidth: 1,
    borderColor: "#262626",
    borderRadius: 8,
    gap: 12,
  },
  avatar: { width: 35, height: 35, alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#ededed" },
  back: { color: "#aaa", fontSize: 22 },
  footer: {
    marginTop: 25,
    textAlign: "center",
    color: "#555",
    fontSize: 12,
  },
  camera: { height: 220, borderRadius: 8, overflow: "hidden" },
  chatHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 16,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: "#222",
  },
  notificationBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  notificationText: { fontSize: 14, color: "#aaa" },
  browserToggle: { alignSelf: "flex-end", paddingHorizontal: 17, paddingVertical: 9 },
  browserToggleText: { fontSize: 14, color: "#888" },
  browserPanel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 17,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: "#222",
  },
  desktopLink: { flex: 1, alignItems: "flex-end" },
  localNote: {
    flex: 1,
    fontSize: 14,
    lineHeight: 12,
    color: "#666",
    textAlign: "right",
  },
  browserPreview: {
    marginHorizontal: 17,
    marginTop: 9,
    borderWidth: 1,
    borderColor: "#303030",
    borderRadius: 7,
    overflow: "hidden",
  },
  previewHeader: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    backgroundColor: "#131313",
  },
  previewLabel: { fontSize: 13, color: "#999" },
  previewViewport: { height: 125, backgroundColor: "#050505" },
  previewPlaceholder: { flex: 1, alignItems: "center", justifyContent: "center" },
  messages: { padding: 20, gap: 20, flexGrow: 1 },
  empty: { flex: 1, minHeight: 250, gap: 22, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontSize: 25, color: "#ededed", letterSpacing: -0.8 },
  bubble: { paddingVertical: 12, maxWidth: "100%", gap: 6 },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#1d1d1d",
    borderWidth: 1,
    borderColor: "#282828",
    borderRadius: 15,
    paddingHorizontal: 16,
    maxWidth: "88%",
  },
  agentBubble: { alignSelf: "stretch", backgroundColor: "transparent" },
  highlight: { borderWidth: 1, borderColor: "#777", borderRadius: 8, padding: 12 },
  messageRole: {
    fontSize: 13,
    color: "#666",
    marginBottom: 6,
  },
  messageText: { fontSize: 15, lineHeight: 25, color: "#ddd" },
  link: { color: "#ddd", textDecorationLine: "underline" },
  retry: { fontSize: 14, color: "#d99b8c" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    marginHorizontal: 16,
    padding: 10,
    paddingLeft: 16,
    backgroundColor: "#141414",
    borderWidth: 1,
    borderColor: "#333",
    borderRadius: 14,
  },
  draft: {
    flex: 1,
    color: "#ededed",
    fontSize: 15,
    paddingVertical: 9,
    maxHeight: 140,
  },
  send: {
    height: 34,
    width: 34,
    borderRadius: 7,
    backgroundColor: "#ededed",
    alignItems: "center",
    justifyContent: "center",
  },
  sendText: { fontSize: 24, color: "#111" },
  composerFoot: {
    textAlign: "center",
    fontSize: 13,
    color: "#555",
    marginVertical: 12,
  },
  error: { fontSize: 12, color: "#d99b8c", padding: 12, backgroundColor: "#201511" },
});
const markdownStyles = StyleSheet.create({
  body: { fontSize: 15, lineHeight: 25, color: "#d4d4d4" },
  heading1: { fontSize: 22, color: "#ededed", fontFamily: "Geist", marginBottom: 12 },
  heading2: { fontSize: 19, color: "#ededed", fontFamily: "Geist", marginBottom: 10 },
  heading3: { fontSize: 17, color: "#ededed", fontFamily: "Geist" },
  paragraph: { marginTop: 0, marginBottom: 12 },
  strong: { fontWeight: "600", color: "#ededed" },
  code_inline: {
    fontFamily: "GeistMono",
    fontSize: 13,
    color: "#ddd",
    backgroundColor: "#242424",
    borderWidth: 0,
  },
  fence: {
    fontFamily: "GeistMono",
    fontSize: 13,
    lineHeight: 20,
    color: "#ddd",
    backgroundColor: "#111",
    borderColor: "#333",
    borderRadius: 7,
    padding: 14,
  },
  code_block: {
    fontFamily: "GeistMono",
    fontSize: 13,
    color: "#ddd",
    backgroundColor: "#111",
    borderColor: "#333",
  },
  blockquote: { backgroundColor: "#161616", borderColor: "#444" },
  link: { color: "#ddd" },
  table: { borderColor: "#333" },
  tr: { borderColor: "#333" },
  hr: { backgroundColor: "#333" },
});
