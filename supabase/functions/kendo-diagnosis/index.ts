import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type DiagnosisPayload = {
  stance?: string;
  target?: string;
  elbowAngle?: number | string;
  wristDiff?: string | number;
  avgElbowAngle?: number | string | null;
  poseFrames?: number | string | null;
  detectionQuality?: string | null;
};

type GeminiDiagnosis = {
  diagnosis: string;
  practicePlan: string;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Preflight — must not 404
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiApiKey) {
      console.error(JSON.stringify({
        provider: "gemini",
        errorStatus: "MISSING_SECRET",
        hasGeminiKey: false,
        deploymentId: Deno.env.get("DENO_DEPLOYMENT_ID") || null,
        executionId: Deno.env.get("SB_EXECUTION_ID") || null,
      }));
      return jsonResponse({
        error: "missing_provider_secret",
        code: "GEMINI_API_KEY_MISSING",
        provider: "gemini",
      }, 500);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse(
        { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
        500,
      );
    }

    const payload = (await req.json()) as DiagnosisPayload;
    const stance = String(payload.stance ?? "").trim();
    const target = String(payload.target ?? "").trim();
    const elbowAngle = Number(payload.elbowAngle);
    const wristDiff = String(payload.wristDiff ?? "").trim();
    const avgElbowAngle = payload.avgElbowAngle == null || payload.avgElbowAngle === ""
      ? null
      : Number(payload.avgElbowAngle);
    const poseFrames = payload.poseFrames == null || payload.poseFrames === ""
      ? null
      : Number(payload.poseFrames);
    const detectionQuality = String(payload.detectionQuality ?? "unknown").trim();

    if (!stance || !target || !Number.isFinite(elbowAngle) || !wristDiff) {
      return jsonResponse({
        error:
          "Invalid payload. Required: stance, target, elbowAngle (number), wristDiff",
      }, 400);
    }

    const systemInstruction =
      "你是一名兼具傳統精神與現代運動科學的資深劍道八段教練。" +
      "你只能根據學員「已偵測到」的動作數據做診斷，不可忽略數據、不可憑空假設未提供的動作細節。" +
      "必須在 diagnosis 開頭用 <p> 清楚引用實際數值（例如最大手肘角度、平均角度、雙手高度差、偵測品質）。" +
      "若 detectionQuality 為 fair，要提醒拍攝／入鏡可能影響準確度，但仍要基於現有數值給建議。" +
      "只輸出 JSON，欄位必須包含 diagnosis 與 practicePlan。" +
      "diagnosis：針對該姿態(stance)與打擊目標(target)的問題診斷與姿勢改善，用 HTML（<p>、<ul>、<li>、<strong>）包裝。" +
      "practicePlan：可執行的自主練習菜單，對應你指出的問題，同樣用 HTML 包裝。" +
      "請使用繁體中文（香港用語可接受）。";

    const userPrompt = [
      "以下數據來自電腦視覺（MediaPipe Pose）在學員揮刀錄影中「實際偵測」到的結果。",
      "請先確認已偵測到動作，再只根據這些數值做診斷與練習建議，不要編造未出現的動作細節。",
      `- stance（姿態）: ${stance}`,
      `- target（打擊目標）: ${target}`,
      `- elbowAngle（錄影期間最大手肘角度，度）: ${elbowAngle}`,
      `- avgElbowAngle（錄影期間平均手肘角度，度）: ${avgElbowAngle ?? "n/a"}`,
      `- wristDiff（雙手高度差）: ${wristDiff}`,
      `- poseFrames（成功偵測骨架幀數）: ${poseFrames ?? "n/a"}`,
      `- detectionQuality（偵測品質）: ${detectionQuality}`,
    ].join("
");t}`,
      `- elbowAngle（錄影期間最大手肘角度，度）: ${elbowAngle}`,
      `- avgElbowAngle（錄影期間平均手肘角度，度）: ${avgElbowAngle ?? "n/a"}`,
      `- wristDiff（雙手高度差）: ${wristDiff}`,
      `- poseFrames（成功偵測骨架幀數）: ${poseFrames ?? "n/a"}`,
      `- detectionQuality（偵測品質）: ${detectionQuality}`,
    ].join("\n");

    const geminiEndpoint =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      `gemini-3.6-flash:generateContent?key=${encodeURIComponent(geminiApiKey)}`;

    const geminiRes = await fetch(geminiEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.4,
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      let upstreamStatus = "UNKNOWN";
      let upstreamMessage = "";
      try {
        const parsed = JSON.parse(errText);
        upstreamStatus = parsed?.error?.status || upstreamStatus;
        upstreamMessage = parsed?.error?.message || "";
      } catch {
        // keep raw truncated internally only
        upstreamMessage = errText.slice(0, 200);
      }

      // Safe diagnostics — never log API keys, Authorization, prompts, or full payloads
      console.error(JSON.stringify({
        provider: "gemini",
        model: "gemini-3.6-flash",
        endpointFamily: "generativelanguage",
        httpStatus: geminiRes.status,
        errorStatus: upstreamStatus,
        deploymentId: Deno.env.get("DENO_DEPLOYMENT_ID") || null,
        executionId: Deno.env.get("SB_EXECUTION_ID") || null,
        hasGeminiKey: Boolean(Deno.env.get("GEMINI_API_KEY")),
      }));

      // Map upstream authz denial to controlled gateway error for the caller
      if (geminiRes.status === 403 || upstreamStatus === "PERMISSION_DENIED") {
        return jsonResponse({
          error: "upstream_provider_denied",
          code: "GEMINI_PERMISSION_DENIED",
          provider: "gemini",
          status: 403,
          // short hint without leaking internals
          message: "Gemini project/API access denied. Check Google project billing, API enablement, and the GEMINI_API_KEY secret.",
        }, 502);
      }
      if (geminiRes.status === 401) {
        return jsonResponse({
          error: "upstream_provider_unauthorized",
          code: "GEMINI_API_KEY_INVALID",
          provider: "gemini",
          status: 401,
        }, 502);
      }
      if (geminiRes.status === 404) {
        return jsonResponse({
          error: "upstream_model_not_found",
          code: "GEMINI_MODEL_NOT_FOUND",
          provider: "gemini",
          status: 404,
        }, 502);
      }
      if (geminiRes.status === 429) {
        return jsonResponse({
          error: "upstream_rate_limited",
          code: "GEMINI_RATE_LIMIT",
          provider: "gemini",
          status: 429,
        }, 503);
      }
      return jsonResponse({
        error: "Gemini API request failed",
        code: "GEMINI_UPSTREAM_ERROR",
        provider: "gemini",
        status: geminiRes.status,
      }, 502);
    }

    const geminiJson = await geminiRes.json();
    const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    let diagnosisResult: GeminiDiagnosis;
    try {
      diagnosisResult = JSON.parse(rawText) as GeminiDiagnosis;
    } catch {
      console.error("Failed to parse Gemini JSON:", rawText);
      return jsonResponse({ error: "Gemini returned non-JSON content", raw: rawText }, 502);
    }

    if (!diagnosisResult.diagnosis || !diagnosisResult.practicePlan) {
      return jsonResponse({
        error: "Gemini JSON missing diagnosis or practicePlan",
        diagnosisResult,
      }, 502);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: row, error: dbError } = await supabase
      .from("kendo_records")
      .insert({
        stance,
        target,
        elbow_angle: elbowAngle,
        wrist_diff: wristDiff,
        diagnosis: diagnosisResult.diagnosis,
        practice_plan: diagnosisResult.practicePlan,
        raw_metrics: { stance, target, elbowAngle, wristDiff, avgElbowAngle, poseFrames, detectionQuality },
      })
      .select("*")
      .single();

    if (dbError) {
      console.error("DB insert error:", dbError);
      return jsonResponse({
        error: "Failed to insert kendo_records",
        detail: dbError.message,
        diagnosis: diagnosisResult.diagnosis,
        practicePlan: diagnosisResult.practicePlan,
      }, 500);
    }

    return jsonResponse({
      ok: true,
      diagnosis: diagnosisResult.diagnosis,
      practicePlan: diagnosisResult.practicePlan,
      record: row,
    });
  } catch (err) {
    console.error("Unhandled error:", err);
    return jsonResponse({
      error: "Internal server error",
      detail: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
