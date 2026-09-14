import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type DiagnosisPayload = {
  stance: string;
  target: string;
  elbowAngle: number;
  wristDiff: string;
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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiApiKey) {
      return jsonResponse({ error: "Missing GEMINI_API_KEY secret" }, 500);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse(
        { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
        500,
      );
    }

    const payload = (await req.json()) as Partial<DiagnosisPayload>;
    const stance = String(payload.stance ?? "").trim();
    const target = String(payload.target ?? "").trim();
    const elbowAngle = Number(payload.elbowAngle);
    const wristDiff = String(payload.wristDiff ?? "").trim();

    if (!stance || !target || !Number.isFinite(elbowAngle) || !wristDiff) {
      return jsonResponse(
        {
          error:
            "Invalid payload. Required: stance, target, elbowAngle (number), wristDiff",
        },
        400,
      );
    }

    const systemInstruction =
      "你是一名兼具傳統精神與現代運動科學的資深劍道八段教練。請根據學員傳入的角度數據進行專業動作診斷與練習建議。" +
      "必須只輸出 JSON，欄位為 diagnosis 與 practicePlan。" +
      "diagnosis：動作問題診斷與姿勢改善建議，用 HTML 標籤（例如 <p>、<ul>、<li>、<strong>）包裝。" +
      "practicePlan：針對性自主練習菜單，同樣用 HTML 標籤包裝。" +
      "內容使用繁體中文。";

    const userPrompt = [
      "請診斷以下劍道動作數據：",
      `- stance: ${stance}`,
      `- target: ${target}`,
      `- elbowAngle: ${elbowAngle}`,
      `- wristDiff: ${wristDiff}`,
    ].join("\n");

    const geminiEndpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiApiKey)}`;

    const geminiRes = await fetch(geminiEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userPrompt }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.4,
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini error:", geminiRes.status, errText);
      return jsonResponse(
        { error: "Gemini API request failed", detail: errText },
        502,
      );
    }

    const geminiJson = await geminiRes.json();
    const rawText =
      geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    let diagnosisResult: GeminiDiagnosis;
    try {
      diagnosisResult = JSON.parse(rawText) as GeminiDiagnosis;
    } catch {
      console.error("Failed to parse Gemini JSON:", rawText);
      return jsonResponse(
        { error: "Gemini returned non-JSON content", raw: rawText },
        502,
      );
    }

    if (!diagnosisResult.diagnosis || !diagnosisResult.practicePlan) {
      return jsonResponse(
        { error: "Gemini JSON missing diagnosis or practicePlan", diagnosisResult },
        502,
      );
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
        raw_metrics: {
          stance,
          target,
          elbowAngle,
          wristDiff,
        },
      })
      .select("*")
      .single();

    if (dbError) {
      console.error("DB insert error:", dbError);
      return jsonResponse(
        {
          error: "Failed to insert kendo_records",
          detail: dbError.message,
          diagnosis: diagnosisResult.diagnosis,
          practicePlan: diagnosisResult.practicePlan,
        },
        500,
      );
    }

    return jsonResponse({
      ok: true,
      diagnosis: diagnosisResult.diagnosis,
      practicePlan: diagnosisResult.practicePlan,
      record: row,
    });
  } catch (err) {
    console.error("Unhandled error:", err);
    return jsonResponse(
      {
        error: "Internal server error",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});
