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

    // 文獻啟發式基準（教學用，非全日本剣道連盟正式評分）
    // 参考：横山・百鬼・久保等 標準3D正面打撃；Murase 等八段面打；筑波系正面打突研究
    const wristNum = Number(wristDiff);
    const absWrist = Number.isFinite(wristNum) ? Math.abs(wristNum) : null;
    const targetNorm = target.toLowerCase();
    const isMen = /面|men/.test(targetNorm) || target.includes("面");
    const isKote = /小手|kote/.test(targetNorm) || target.includes("小手");
    const isDo = /胴|do|どう/.test(targetNorm) || target.includes("胴");

    const heuristicNotes: string[] = [];
    if (isMen) {
      if (elbowAngle < 140) {
        heuristicNotes.push(
          `面打啟發式：最大右肘角 ${elbowAngle}° < 140°，傾向「振り下ろし伸展不足」（文獻常見右肘先屈後伸）。`,
        );
      } else if (elbowAngle <= 175) {
        heuristicNotes.push(
          `面打啟發式：最大右肘角 ${elbowAngle}° 約在教學常見範圍（140–175°），伸展大致合理。`,
        );
      } else {
        heuristicNotes.push(
          `面打啟發式：最大右肘角 ${elbowAngle}° 偏高，可能過度伸直或量度雜訊；文獻強調右肘協調屈伸、左肘相對穩定。`,
        );
      }
    } else if (isKote) {
      heuristicNotes.push(
        `小手啟發式：小手通常比面打更短促；唔好硬套面打最大伸展標準。`,
      );
    } else if (isDo) {
      heuristicNotes.push(
        `胴／返し胴啟發式：更強調時機與刃筋；角度僅作輔助，可對照返し胴教學片。`,
      );
    } else {
      heuristicNotes.push(
        `目標「${target}」：以打突協調為準，右肘操作清晰、雙手高度差不宜過大。`,
      );
    }

    if (absWrist != null) {
      if (absWrist > 0.08) {
        heuristicNotes.push(
          `雙手高度差 |wristDiff|=${absWrist.toFixed(3)} 偏大（啟發式門檻約 0.08）：可能左右手不夠協調。`,
        );
      } else {
        heuristicNotes.push(
          `雙手高度差 |wristDiff|=${absWrist.toFixed(3)} 屬較協調範圍（啟發式）。`,
        );
      }
    }

    if (avgElbowAngle != null && Number.isFinite(avgElbowAngle) && isMen) {
      const delta = elbowAngle - avgElbowAngle;
      if (delta < 15) {
        heuristicNotes.push(
          `最大角與平均角差距偏小（Δ=${delta.toFixed(1)}°）：可能缺少明顯「先屈後伸」峰值。`,
        );
      } else {
        heuristicNotes.push(
          `最大角相對平均角有明顯峰值（Δ=${delta.toFixed(1)}°），符合右肘動態屈伸方向。`,
        );
      }
    }

    if (detectionQuality === "fair") {
      heuristicNotes.push("偵測品質 fair：入鏡／光線可能影響準確度，建議對照參考影片再錄一次。");
    }

    // 鹿屋・日體大・國際武道大／氣劍體：而家前端未量踏込時間差，以教學啟發式提示
    heuristicNotes.push(
      "氣劍體一致（鹿屋・竹中等）：打突著打與右足踏み込み宜接近同時；若感覺「先打後踏」或「先踏後打」，練習時用聲音／影像檢查時間差。",
    );
    heuristicNotes.push(
      "間合（日本體大・袴田等「間のつめ」）：由遠入近時保持姿勢穩定再打；勿只伸手夠遠而塌腰／散架。",
    );
    heuristicNotes.push(
      "下肢（國際武道大系／踏込研究）：左足引き付け、右足踏込距離與腰上下動影響打突穩定；手機側視／全身入鏡較易自我檢查。",
    );
    if (isMen) {
      heuristicNotes.push(
        "手の内（日體大反應／打突研究脈絡）：面打宜小指側主導握法意識，双手協調勝於只靠右手發力。",
      );
    }

    const benchmarkNotes =
      "<p><strong>文獻對照（啟發式）</strong>：参考筑波系／標準正面打突3D模型、八段面打關節研究，《劍道時代》教練解說，以及鹿屋／日體大／國際武道大相關研究要點。以下不是正式審判標準。</p><ul>" +
      heuristicNotes.map((n) => `<li>${n}</li>`).join("") +
      "</ul>";

    const systemInstruction =
      "你是一名兼具傳統精神與現代運動科學的資深劍道八段教練。" +
      "你只能根據學員已偵測到的動作數據，以及系統提供的文獻啟發式基準做診斷，不可忽略數據、不可憑空假設未提供的細節。" +
      "文獻共識（教學用）：正面打突分振り上げ／振り下ろし；右肘在振り下ろし常先屈後伸；左肘相對穩定；雙手應協調；竹刀軌跡個人差較大，下肢與肘協調較適合做基準。" +
      "必須在 diagnosis 開頭用 <p> 引用實際數值，並簡要對照啟發式基準。" +
      "可建議學員對照報告頁參考影片與大學／劍道時代解說，但不要假裝看過影片或讀過全文。" +
      "教學可引用：氣劍體一致（打突與踏込接近同時）、間のつめ、左手控中心、打ち切る、小手細小快速、一拍子双手協調（冴え）、左足引き付け與腰穩定；不要宣稱量度過未提供的踏込時間。" +
      "只輸出 JSON，欄位必須包含 diagnosis 與 practicePlan；用 HTML 包裝；繁體中文（香港用語可接受）。";

    const userPrompt = [
      "以下數據來自 MediaPipe Pose 實際偵測結果。",
      "請根據數值 + 文獻啟發式基準做診斷與練習建議。",
      `- stance: ${stance}`,
      `- target: ${target}`,
      `- elbowAngle (max): ${elbowAngle}`,
      `- avgElbowAngle: ${avgElbowAngle ?? "n/a"}`,
      `- wristDiff: ${wristDiff}`,
      `- poseFrames: ${poseFrames ?? "n/a"}`,
      `- detectionQuality: ${detectionQuality}`,
      "文獻啟發式基準：",
      ...heuristicNotes.map((n, i) => `${i + 1}. ${n}`),
      "參考資料（學員對照用，你未閱讀／觀看全文）：",
      "1. 返し胴4種類 https://www.youtube.com/watch?v=MwPqKjLozyM",
      "2. 出鼻面5種類 https://www.youtube.com/watch?v=-EGzCr7dWdI",
      "3. 《劍道時代》香田郡秀 仕かけ面 https://kendojidai.com/2020/01/13/koda-kunihides-l2/",
      "4. 《劍道時代》香田郡秀 仕かけて小手 https://kendojidai.net/2020/02/10/koda-kunihide-l2-2/",
      "5. 《劍道時代》面打精煉 https://kendojidai.com/2021/10/18/refining-men-strikes-part-1/",
      "6. 《劍道時代》宮崎史裕 一拍子 https://kendojidai.net/2025/08/25/the-technique-of-striking-in-one-breath-miyazaki-fumihiro/",
      "7. 鹿屋體大・竹中 打突と踏み込み時間差 https://nifs-k.repo.nii.ac.jp/records/801",
      "8. 鹿屋體大・踏込／踵 https://www.jstage.jst.go.jp/article/rjsp/14/0/14_2159/_article/-char/ja",
      "9. 日本體大・袴田 間のつめ https://doi.org/10.11214/budo1968.18.2_45",
      "10. 國際武道大學研究紀要 http://www.budo-u.ac.jp/laboratory/transaction/",
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
        raw_metrics: { stance, target, elbowAngle, wristDiff, avgElbowAngle, poseFrames, detectionQuality, heuristicNotes },
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
        benchmarkNotes,
      }, 500);
    }

    return jsonResponse({
      ok: true,
      diagnosis: diagnosisResult.diagnosis,
      practicePlan: diagnosisResult.practicePlan,
      benchmarkNotes,
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
