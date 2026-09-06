// netlify/functions/kit-tag.js
//
// Securely tags a lead in Kit without ever exposing the API key publicly.
// The browser calls THIS function; this function calls Kit directly using
// a key that only exists in Netlify's private environment variables.
//
// SETUP REQUIRED (one-time, in Netlify's dashboard, not in this file):
//   Site settings → Environment variables → Add a variable
//   Key:   KIT_API_KEY
//   Value: (the kit_... key from Kit's V4 Keys screen)
//
// This function does three things per submission:
//   1. Creates/updates the subscriber in Kit (sets name + results_url field)
//   2. Looks up the real numeric ID for the branch tag (e.g. branch_glp1)
//   3. Looks up the real numeric ID for the status tag (flagged_lead / standard_lead)
// Tag IDs are looked up by name every time rather than hardcoded, so nothing
// breaks if a tag is ever deleted and recreated.

const KIT_API_BASE = "https://api.kit.com/v4";

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.KIT_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "KIT_API_KEY not configured in Netlify" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { email, name, branch, gated, resultsURL } = payload;
  if (!email || !branch) {
    return { statusCode: 400, body: JSON.stringify({ error: "email and branch are required" }) };
  }

  const branchTagMap = {
    glp1: "Branch - GLP1",
    surgery: "Branch - Surgery",
    natural: "Branch - Nutrition"
  };
  const branchTagName = branchTagMap[branch];
  const statusTagName = gated ? "Flagged - Lead" : "Standard - Lead";

  const headers = {
    "Content-Type": "application/json",
    "X-Kit-Api-Key": apiKey
  };

  try {
    // Step 1 — create/update the subscriber with name + results URL field
    const subRes = await fetch(`${KIT_API_BASE}/subscribers`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        email_address: email,
        first_name: name || "",
        fields: { results_url: resultsURL || "" }
      })
    });
    if (!subRes.ok) {
      const errText = await subRes.text();
      console.error('Kit subscriber creation failed:', subRes.status, errText);
      return { statusCode: 500, body: JSON.stringify({ error: "Kit subscriber creation failed", status: subRes.status, detail: errText }) };
    }

    // Step 2 — fetch all tags once, find the IDs we need
    const tagsRes = await fetch(`${KIT_API_BASE}/tags`, { headers });
    if (!tagsRes.ok) {
      const errText = await tagsRes.text();
      console.error('Kit list-tags call failed:', tagsRes.status, errText);
      return { statusCode: 500, body: JSON.stringify({ error: "Kit list-tags call failed", status: tagsRes.status, detail: errText }) };
    }
    const tagsData = await tagsRes.json();
    const allTags = tagsData.tags || [];

    const branchTag = allTags.find(t => t.name === branchTagName);
    const statusTag = allTags.find(t => t.name === statusTagName);

    if (!branchTag || !statusTag) {
      const missing = [!branchTag ? branchTagName : null, !statusTag ? statusTagName : null].filter(Boolean);
      console.error('Tags not found in Kit:', missing, '— full tag list from Kit:', allTags.map(t => t.name));
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "One or more tags not found in Kit — confirm all 7 tags are created with exact spelling",
          missing
        })
      };
    }

    // Step 3 — apply both tags
    const branchTagRes = await fetch(`${KIT_API_BASE}/tags/${branchTag.id}/subscribers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email_address: email })
    });
    if (!branchTagRes.ok) {
      const errText = await branchTagRes.text();
      console.error('Applying branch tag failed:', branchTagRes.status, errText);
      return { statusCode: 500, body: JSON.stringify({ error: "Applying branch tag failed", status: branchTagRes.status, detail: errText }) };
    }

    const statusTagRes = await fetch(`${KIT_API_BASE}/tags/${statusTag.id}/subscribers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email_address: email })
    });
    if (!statusTagRes.ok) {
      const errText = await statusTagRes.text();
      console.error('Applying status tag failed:', statusTagRes.status, errText);
      return { statusCode: 500, body: JSON.stringify({ error: "Applying status tag failed", status: statusTagRes.status, detail: errText }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('Unexpected error in kit-tag function:', err);
    return { statusCode: 500, body: JSON.stringify({ error: "Kit request failed", detail: String(err) }) };
  }
};
