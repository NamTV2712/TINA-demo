"use client";

import { useState, useEffect } from "react";
import { Settings, CheckCircle2, XCircle, Loader2, ExternalLink, Sparkles, AlertCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { tinaAPI } from "@/lib/api";
import { AdminGuard } from "@/components/admin/admin-guard";
import { withBasePath } from "@/lib/base-path";

interface AIConfig {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  sharedWithTerminal?: boolean;
  chatgpt_connected?: boolean | null;
}

interface RuntimeConfig {
  terminalUrl?: string | null;
  wsUrl: string;
  apiUrl: string;
}

interface TranscriptionConfig {
  label: string;
  backend: string;
  source: "user" | "platform" | "environment";
}

function SettingsContent() {
  const [isTesting, setIsTesting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<"unknown" | "connected" | "error">("unknown");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [aiConfig, setAIConfig] = useState<AIConfig | null>(null);
  const [isLoadingAIConfig, setIsLoadingAIConfig] = useState(true);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [transcriptionConfig, setTranscriptionConfig] = useState<TranscriptionConfig | null>(null);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);

  // Fetch configurations on mount
  useEffect(() => {
    let alive = true;
    async function fetchTranscription() {
      try {
        const response = await fetch(withBasePath("/api/tina/user/transcription"), { cache: "no-store" });
        if (!response.ok) throw new Error(response.status === 401 ? "Sign in to view your transcription settings." : "Transcription settings are unavailable.");
        const data = await response.json();
        if (!data.effective) throw new Error("The server has not reported its effective transcription settings.");
        if (alive) { setTranscriptionConfig(data.effective); setTranscriptionError(null); }
      } catch (error) {
        if (alive) { setTranscriptionConfig(null); setTranscriptionError((error as Error).message); }
      }
    }
    async function fetchConfigs() {
      // Fetch runtime config (WebSocket URL)
      try {
        const configResponse = await fetch(withBasePath("/api/config"));
        const config = await configResponse.json();
        setRuntimeConfig(config);
      } catch (error) {
        console.error("Failed to fetch runtime config:", error);
      }

      // Fetch AI config
      try {
        const response = await fetch(withBasePath("/api/ai/config"));
        const config = await response.json();
        setAIConfig(config);
      } catch (error) {
        console.error("Failed to fetch AI config:", error);
        setAIConfig({ enabled: false, provider: null, model: null });
      } finally {
        setIsLoadingAIConfig(false);
      }
    }
    fetchConfigs();
    void fetchTranscription();
    window.addEventListener("focus", fetchTranscription);
    return () => { alive = false; window.removeEventListener("focus", fetchTranscription); };
  }, []);

  const handleTestConnection = async () => {
    setIsTesting(true);
    setConnectionStatus("unknown");
    setConnectionError(null);

    try {
      const result = await tinaAPI.testConnection();
      if (result.success) {
        setConnectionStatus("connected");
        toast.success("Connection successful", {
          description: "Successfully connected to TINA API",
        });
      } else {
        setConnectionStatus("error");
        setConnectionError(result.error || "Unknown error");
        toast.error("Connection failed", {
          description: result.error,
        });
      }
    } catch (error) {
      setConnectionStatus("error");
      setConnectionError((error as Error).message);
      toast.error("Connection failed", {
        description: (error as Error).message,
      });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Configure your TINA Dashboard connection
        </p>
      </div>

      <div className="max-w-2xl space-y-6">
        {/* API Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              TINA API Configuration
            </CardTitle>
            <CardDescription>
              Configure the connection to your TINA instance. These settings are managed via environment variables.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* API URL */}
            <div className="space-y-2">
              <Label htmlFor="apiUrl">API URL</Label>
              <Input
                id="apiUrl"
                value={runtimeConfig?.apiUrl || "Loading..."}
                disabled
                className="font-mono bg-muted"
              />
              <p className="text-xs text-muted-foreground">
                Set via <code className="bg-muted px-1 rounded">TINA_API_URL</code> environment variable
              </p>
            </div>

            {/* WebSocket URL */}
            <div className="space-y-2">
              <Label htmlFor="wsUrl">WebSocket URL</Label>
              <Input
                id="wsUrl"
                value={runtimeConfig?.wsUrl || "Loading..."}
                disabled
                className="font-mono bg-muted"
              />
              <p className="text-xs text-muted-foreground">
                Auto-derived from <code className="bg-muted px-1 rounded">TINA_API_URL</code>
              </p>
            </div>

            {/* Admin API Key Status */}
            <div className="space-y-2">
              <Label>Admin API Key</Label>
              <div className="flex items-center gap-2">
                <Input
                  value="••••••••••••••••••••••••••••••••"
                  disabled
                  className="font-mono bg-muted"
                />
                <Badge variant="secondary">Configured</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Set via <code className="bg-muted px-1 rounded">TINA_ADMIN_API_KEY</code> environment variable
              </p>
            </div>

            <Separator />

            {/* Test Connection */}
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="font-medium">Connection Status</p>
                <div className="flex items-center gap-2">
                  {connectionStatus === "connected" && (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                      <span className="text-sm text-green-600">Connected</span>
                    </>
                  )}
                  {connectionStatus === "error" && (
                    <>
                      <XCircle className="h-4 w-4 text-red-500" />
                      <span className="text-sm text-red-600">
                        {connectionError || "Connection failed"}
                      </span>
                    </>
                  )}
                  {connectionStatus === "unknown" && (
                    <span className="text-sm text-muted-foreground">Not tested</span>
                  )}
                </div>
              </div>
              <Button onClick={handleTestConnection} disabled={isTesting}>
                {isTesting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Testing...
                  </>
                ) : (
                  "Test Connection"
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Speech to text</CardTitle>
            <CardDescription>Shared with TINA Terminal. New meeting bot sessions use this selection; active sessions keep their backend.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {transcriptionConfig ? <>
              <p className="font-medium">{transcriptionConfig.label}</p>
              <Badge variant="secondary">{{ user: "Personal preference", platform: "Platform default", environment: "Deployment environment" }[transcriptionConfig.source]}</Badge>
            </> : <p className="text-sm text-muted-foreground" role="status">{transcriptionError || "Loading transcription settings…"}</p>}
            <p className="text-sm text-muted-foreground">Configure in TINA Terminal → Settings → Models → Transcription. To change the default for all clients, use Global defaults.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Model AI dùng chung với Terminal</CardTitle><CardDescription>Dashboard dùng cấu hình của chính tài khoản đang đăng nhập.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            {isLoadingAIConfig ? <p>Đang đọc cấu hình…</p> : aiConfig?.model ? <>
              <p className="font-medium">{aiConfig.model}</p>
              <Badge variant="secondary">TINA Agent · cùng cấu hình với Terminal</Badge>
              {aiConfig.chatgpt_connected === false && <p role="status">Bạn cần kết nối lại tài khoản ChatGPT trong Terminal.</p>}
            </> : <p role="status">Chưa đọc được cấu hình. Hãy đăng nhập và thử lại.</p>}
            <p className="text-sm text-muted-foreground">Đổi model hoặc tài khoản ChatGPT tại Terminal → Settings → Models. Lựa chọn đó sẽ áp dụng cho các yêu cầu AI mới ở Dashboard.</p>
            {runtimeConfig?.terminalUrl && <a className="text-sm underline" href={runtimeConfig.terminalUrl} target="_blank" rel="noopener noreferrer">Mở TINA Terminal</a>}
          </CardContent>
        </Card>

        {/* Environment Variables */}
        <Card>
          <CardHeader>
            <CardTitle>Environment Variables</CardTitle>
            <CardDescription>
              To configure the dashboard, create a <code className="bg-muted px-1 rounded">.env.local</code> file with these variables
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted p-4 rounded-lg text-sm overflow-x-auto">
{`# TINA API Configuration (required)
	TINA_API_URL=<your-api-gateway-url>
TINA_ADMIN_API_KEY=your_admin_api_key_here

# AI Assistant Configuration (optional)
# Format: provider/model
AI_MODEL=openai/gpt-4o
AI_API_KEY=your_ai_api_key_here`}
            </pre>
          </CardContent>
        </Card>

        {/* About */}
        <Card>
          <CardHeader>
            <CardTitle>About</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Version</span>
              <span className="font-medium">1.0.0</span>
            </div>
            <Separator />
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                TINA Dashboard is an open source web interface for TINA, the self-hosted meeting transcription API.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <AdminGuard>
      <SettingsContent />
    </AdminGuard>
  );
}
