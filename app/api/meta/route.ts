import { NextRequest, NextResponse } from "next/server";

const META_API_VERSION = "v21.0";
const META_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveToken(clientToken?: string | null): string {
  const token = clientToken?.trim() || process.env.META_GENERAL_TOKEN || "";
  if (!token) throw new Error("Nenhum token Meta Ads disponível.");
  return token;
}

async function metaFetch(path: string, params: Record<string, string>) {
  const url = new URL(`${META_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { next: { revalidate: 0 } });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? "Erro Meta API");
  return json;
}

// ─── GET /api/meta?action=accounts ───────────────────────────────────────────
// ─── GET /api/meta?action=insights&account_id=act_xxx&since=&until= ──────────

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const action     = searchParams.get("action");
  const clientToken = searchParams.get("token");

  try {
    const token = resolveToken(clientToken);

    // ── Listar contas disponíveis ────────────────────────────────────────────
    if (action === "accounts") {
      const data = await metaFetch("/me/adaccounts", {
        access_token: token,
        fields: "id,name,account_status,currency",
        limit: "100",
      });

      const accounts = (data.data ?? []).map((a: Record<string, unknown>) => ({
        id:      a.id,
        name:    a.name,
        status:  a.account_status,
        currency: a.currency,
      }));

      return NextResponse.json({ accounts });
    }

    // ── Buscar insights de uma conta ─────────────────────────────────────────
    if (action === "insights") {
      const accountId = searchParams.get("account_id");
      const since     = searchParams.get("since");
      const until     = searchParams.get("until");

      if (!accountId) return NextResponse.json({ error: "account_id obrigatório" }, { status: 400 });

      // 1. Status da conta
      const accountData = await metaFetch(`/${accountId}`, {
        access_token: token,
        fields: "account_status,name,currency",
      });

      // 2. Insights: spend + actions com breakdown por campanha para calcular CPL por objetivo
      const insightParams: Record<string, string> = {
        access_token: token,
        // action_values permite calcular spend proporcional por objetivo de conversão
        fields: "spend,actions,cost_per_action_type",
        level: "account",
      };

      if (since && until) {
        insightParams.time_range = JSON.stringify({ since, until });
      } else {
        insightParams.date_preset = "maximum";
      }

      let totalSpend      = 0;
      let leadsCount      = 0;   // Form leads (leadgen nativo)
      let messagesCount   = 0;   // Mensagens / lead via conversa
      let formCpl         = 0;
      let messageCpl      = 0;

      try {
        const insightData = await metaFetch(`/${accountId}/insights`, insightParams);
        const row = insightData.data?.[0];

        if (row) {
          totalSpend = parseFloat(row.spend ?? "0");

          // ── Contagem de leads por tipo ────────────────────────────────────
          const actions: { action_type: string; value: string }[] = row.actions ?? [];
          for (const act of actions) {
            if (act.action_type === "lead" || act.action_type === "leadgen_grouped") {
              leadsCount += parseInt(act.value ?? "0", 10);
            }
            if (
              act.action_type === "onsite_conversion.lead_grouped" ||
              act.action_type === "onsite_conversion.messaging_conversation_started_7d"
            ) {
              messagesCount += parseInt(act.value ?? "0", 10);
            }
          }

          // ── CPL por objetivo via cost_per_action_type ─────────────────────
          const cpaList: { action_type: string; value: string }[] = row.cost_per_action_type ?? [];

          // CPL de formulário: usa o menor custo disponível entre tipos de lead form
          const formCpaTypes = ["lead", "leadgen_grouped"];
          for (const cpa of cpaList) {
            if (formCpaTypes.includes(cpa.action_type)) {
              const v = parseFloat(cpa.value ?? "0");
              if (v > 0 && (formCpl === 0 || v < formCpl)) formCpl = v;
            }
          }

          // CPL de mensagens
          const msgCpaTypes = [
            "onsite_conversion.lead_grouped",
            "onsite_conversion.messaging_conversation_started_7d",
          ];
          for (const cpa of cpaList) {
            if (msgCpaTypes.includes(cpa.action_type)) {
              const v = parseFloat(cpa.value ?? "0");
              if (v > 0 && (messageCpl === 0 || v < messageCpl)) messageCpl = v;
            }
          }

          // Fallback: se não veio cost_per_action, calcula pela proporção de leads
          const total = leadsCount + messagesCount;
          if (total > 0) {
            if (formCpl === 0 && leadsCount > 0) {
              formCpl = (totalSpend * (leadsCount / total)) / leadsCount;
            }
            if (messageCpl === 0 && messagesCount > 0) {
              messageCpl = (totalSpend * (messagesCount / total)) / messagesCount;
            }
          }
        }
      } catch {
        // Conta sem dados de insight (ex: sem campanhas) — retorna zeros
      }

      const totalLeads = leadsCount + messagesCount;
      const cpl = totalLeads > 0 ? totalSpend / totalLeads : 0;

      // Spend estimado por objetivo (proporcional ao volume de leads)
      const formSpend = totalLeads > 0 && leadsCount > 0
        ? totalSpend * (leadsCount / totalLeads)
        : 0;
      const msgSpend = totalLeads > 0 && messagesCount > 0
        ? totalSpend * (messagesCount / totalLeads)
        : 0;

      return NextResponse.json({
        account_status: accountData.account_status as number,
        account_name:   accountData.name as string,
        currency:       (accountData.currency as string) ?? "BRL",
        spend:          totalSpend,
        leads:          leadsCount,
        messages:       messagesCount,
        total_leads:    totalLeads,
        cpl,
        // Por objetivo
        form_leads:    leadsCount,
        form_spend:    formSpend,
        form_cpl:      formCpl,
        msg_leads:     messagesCount,
        msg_spend:     msgSpend,
        msg_cpl:       messageCpl,
      });
    }

    return NextResponse.json({ error: "action inválida" }, { status: 400 });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erro desconhecido";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
