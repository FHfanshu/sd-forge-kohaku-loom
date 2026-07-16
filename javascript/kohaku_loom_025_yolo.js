(function () {
    const tools = window.kohakuLoom;
    if (!tools) return;

    const YOLO_TOOL_NAMES = new Set(["read_txt2img_state", "apply_txt2img_patch"]);
    const PARAMETER_SPECS = {
        seed: { selector: "#txt2img_seed", kind: "integer", min: -1, max: 4294967295 },
        width: { selector: "#txt2img_width", kind: "integer", min: 64, max: 4096 },
        height: { selector: "#txt2img_height", kind: "integer", min: 64, max: 4096 },
        steps: { selector: "#txt2img_steps", kind: "integer", min: 1, max: 150 },
        cfg_scale: { selector: "#txt2img_cfg_scale", kind: "number", min: 0, max: 30 },
        sampler: { selector: "#txt2img_sampling", kind: "choice" },
        scheduler: { selector: "#txt2img_scheduler", kind: "choice" }
    };

    function isYoloMode() {
        return tools.assistantState.agentMode === "yolo";
    }

    function isYoloTool(name) {
        return YOLO_TOOL_NAMES.has(String(name || ""));
    }

    function fieldControl(field) {
        const root = tools.promptFieldRootForTarget("txt2img", field).root;
        return root?.querySelector("textarea, input") || null;
    }

    function parameterRoot(spec) {
        return tools.loomApp().querySelector(spec.selector);
    }

    function parameterControl(spec) {
        const root = parameterRoot(spec);
        if (!root) return null;
        if (root.matches?.("input, textarea, select")) return root;
        if (spec.kind === "choice") {
            return root.querySelector("select, input[type='radio']:checked, input[role='combobox'], input:not([type='hidden']):not([type='button']):not([type='radio'])");
        }
        return root.querySelector("input[type='number'], input:not([type='hidden']):not([type='button']), select");
    }

    function choiceOptions(spec) {
        const root = parameterRoot(spec);
        const values = [];
        root?.querySelectorAll("select option, input[type='radio'], datalist option, [role='option']").forEach(function (node) {
            const value = String(node.value ?? node.getAttribute?.("data-value") ?? node.textContent ?? "").trim();
            if (value) values.push(value);
        });
        return Array.from(new Set(values));
    }

    async function apiChoiceOptions(name) {
        const path = name === "sampler" ? "/sdapi/v1/samplers" : "/sdapi/v1/schedulers";
        const response = await fetch(path);
        if (!response.ok) throw new Error(`could not load ${name} choices: HTTP ${response.status}`);
        const items = await response.json();
        if (!Array.isArray(items)) throw new Error(`${name} choices response is invalid`);
        return Array.from(new Set(items.flatMap(function (item) {
            const values = [item?.label, item?.name].concat(Array.isArray(item?.aliases) ? item.aliases : []);
            return values.map(function (value) { return String(value || "").trim(); }).filter(Boolean);
        })));
    }

    async function availableChoiceOptions(name, spec) {
        const local = choiceOptions(spec);
        if (local.length) return local;
        return await apiChoiceOptions(name);
    }

    function readParameter(name, spec) {
        const control = parameterControl(spec);
        if (!control) return { ok: false, error: `${name} control is unavailable` };
        const raw = String(control.value ?? "");
        if (spec.kind === "choice") {
            return { ok: true, value: raw, options: choiceOptions(spec) };
        }
        const value = Number(raw);
        if (!Number.isFinite(value)) return { ok: false, error: `${name} is not numeric` };
        return { ok: true, value: value };
    }

    function txt2imgStateSnapshot() {
        const positive = fieldControl("positive");
        const negative = fieldControl("negative");
        if (!positive || !negative) return { ok: false, error: "txt2img prompt controls are unavailable" };
        const state = {
            positive_prompt: String(positive.value || ""),
            negative_prompt: String(negative.value || ""),
            seed: 0,
            width: 0,
            height: 0,
            steps: 0,
            cfg_scale: 0,
            sampler: "",
            scheduler: "",
            checkpoint: tools.currentCheckpoint(),
            forge_preset: tools.currentForgePreset()
        };
        const options = {};
        for (const [name, spec] of Object.entries(PARAMETER_SPECS)) {
            const result = readParameter(name, spec);
            if (!result.ok) return result;
            state[name] = result.value;
            if (result.options?.length) options[name] = result.options;
        }
        return {
            ok: true,
            state: state,
            options: options,
            state_hash: tools.promptHash(JSON.stringify(state))
        };
    }

    function yoloCallAuthorized(args) {
        return isYoloMode() || args?._yolo_authorized === true;
    }

    function readTxt2ImgStateTool(args) {
        if (!yoloCallAuthorized(args)) return { ok: false, error: "YOLO mode is required" };
        const snapshot = txt2imgStateSnapshot();
        if (!snapshot.ok) return snapshot;
        tools.assistantState.txt2imgStateRead = {
            state_hash: snapshot.state_hash,
            state: snapshot.state,
            at: Date.now()
        };
        return Object.assign({ ok: true, target: "txt2img" }, snapshot.state, {
            state_hash: snapshot.state_hash,
            available_options: snapshot.options
        });
    }

    function plannedPrompt(current, patches, positive) {
        if (!Array.isArray(patches) || !patches.length) return { ok: false, error: "prompt patches must be a non-empty array" };
        let value = current;
        for (let index = 0; index < patches.length; index += 1) {
            const result = tools.applyPromptPatchText(value, patches[index] || {});
            if (!result.ok) return { ok: false, error: result.error, failed_index: index };
            value = result.text;
        }
        const residue = tools.promptPatchResidue(value);
        if (residue.length) return { ok: false, error: "refusing prompt patch residue", residue: residue };
        const noPhrases = positive ? tools.positivePromptNoPhrases(value) : [];
        if (noPhrases.length) return { ok: false, error: "refusing no-phrases in positive prompt", no_phrases: noPhrases };
        return { ok: true, value: value };
    }

    function validateNumber(name, value, spec, control) {
        const number = Number(value);
        if (!Number.isFinite(number) || (spec.kind === "integer" && !Number.isInteger(number))) return { ok: false, error: `${name} has an invalid numeric value` };
        const controlMin = control.min === "" ? spec.min : Number(control.min);
        const controlMax = control.max === "" ? spec.max : Number(control.max);
        const min = Number.isFinite(controlMin) ? Math.max(spec.min, controlMin) : spec.min;
        const max = Number.isFinite(controlMax) ? Math.min(spec.max, controlMax) : spec.max;
        if (number < min || number > max) return { ok: false, error: `${name} must be between ${min} and ${max}` };
        return { ok: true, value: number };
    }

    async function validateChoice(name, value, spec) {
        const text = String(value || "").trim();
        if (!text || text.length > 100 || /[\r\n\0]/.test(text)) return { ok: false, error: `${name} has an invalid choice value` };
        let options;
        try {
            options = await availableChoiceOptions(name, spec);
        } catch (error) {
            return { ok: false, error: String(error?.message || error) };
        }
        const match = options.find(function (option) { return option.toLowerCase() === text.toLowerCase(); });
        if (!match) return { ok: false, error: `${name} is not an available choice`, available_options: options };
        return { ok: true, value: match };
    }

    function writeChoice(spec, value) {
        const root = parameterRoot(spec);
        const radio = Array.from(root?.querySelectorAll("input[type='radio']") || []).find(function (item) {
            return String(item.value) === String(value);
        });
        if (radio) {
            if (!radio.checked) radio.click();
            return true;
        }
        const control = parameterControl(spec);
        if (!control) return false;
        tools.setNativeValueIfAvailable(control, value);
        return true;
    }

    function writeField(name, value) {
        if (name === "positive_prompt") return tools.setNativeValueIfAvailable(fieldControl("positive"), value);
        if (name === "negative_prompt") return tools.setNativeValueIfAvailable(fieldControl("negative"), value);
        const spec = PARAMETER_SPECS[name];
        if (!spec) return false;
        if (spec.kind === "choice") return writeChoice(spec, value);
        const control = parameterControl(spec);
        return control ? tools.setNativeValueIfAvailable(control, String(value)) : false;
    }

    function rollbackFields(before, names) {
        let ok = true;
        names.slice().reverse().forEach(function (name) {
            try {
                ok = writeField(name, before[name]) && ok;
            } catch (_error) {
                ok = false;
            }
        });
        tools.assistantState.txt2imgStateRead = null;
        return ok;
    }

    function sameValue(left, right) {
        return typeof left === "number" || typeof right === "number" ? Number(left) === Number(right) : String(left) === String(right);
    }

    async function applyTxt2ImgPatchTool(args) {
        if (!yoloCallAuthorized(args)) return { ok: false, error: "YOLO mode is required" };
        const expected = String(args?.state_hash || "").trim();
        const changes = args?.changes;
        const read = tools.assistantState.txt2imgStateRead;
        if (!read) return { ok: false, error: "must call read_txt2img_state before applying a patch" };
        if (!expected) return { ok: false, error: "state_hash from read_txt2img_state is required" };
        if (expected !== read.state_hash) return { ok: false, error: "state_hash does not match the latest read_txt2img_state", latest_state_hash: read.state_hash };
        const actual = txt2imgStateSnapshot();
        if (!actual.ok) return actual;
        if (expected !== actual.state_hash) {
            tools.assistantState.txt2imgStateRead = null;
            return { ok: false, error: "txt2img state changed after read_txt2img_state; read again", actual_state_hash: actual.state_hash };
        }
        if (!changes || typeof changes !== "object" || Array.isArray(changes)) return { ok: false, error: "changes must be an object" };
        const allowed = new Set(["positive_prompt_patches", "negative_prompt_patches", ...Object.keys(PARAMETER_SPECS)]);
        const unknown = Object.keys(changes).filter(function (name) { return !allowed.has(name); });
        if (unknown.length) return { ok: false, error: `unsupported txt2img fields: ${unknown.join(", ")}` };
        if (!Object.keys(changes).length) return { ok: false, error: "changes must not be empty" };

        const plan = {};
        if (Object.prototype.hasOwnProperty.call(changes, "positive_prompt_patches")) {
            const result = plannedPrompt(actual.state.positive_prompt, changes.positive_prompt_patches, true);
            if (!result.ok) return Object.assign({ field: "positive_prompt" }, result);
            plan.positive_prompt = result.value;
        }
        if (Object.prototype.hasOwnProperty.call(changes, "negative_prompt_patches")) {
            const result = plannedPrompt(actual.state.negative_prompt, changes.negative_prompt_patches, false);
            if (!result.ok) return Object.assign({ field: "negative_prompt" }, result);
            plan.negative_prompt = result.value;
        }
        for (const [name, spec] of Object.entries(PARAMETER_SPECS)) {
            if (!Object.prototype.hasOwnProperty.call(changes, name)) continue;
            const control = parameterControl(spec);
            if (!control) return { ok: false, error: `${name} control is unavailable` };
            const result = spec.kind === "choice" ? await validateChoice(name, changes[name], spec) : validateNumber(name, changes[name], spec, control);
            if (!result.ok) return result;
            plan[name] = result.value;
        }

        const changedNames = Object.keys(plan).filter(function (name) { return !sameValue(actual.state[name], plan[name]); });
        if (!changedNames.length) return { ok: true, target: "txt2img", changed: false, changes: [], state_hash: actual.state_hash };
        const latest = txt2imgStateSnapshot();
        if (!latest.ok) return latest;
        if (expected !== latest.state_hash) {
            tools.assistantState.txt2imgStateRead = null;
            return { ok: false, error: "txt2img state changed while preparing the patch; read again", actual_state_hash: latest.state_hash };
        }
        const before = Object.assign({}, actual.state);
        const audit = changedNames.map(function (name) { return { field: name, before: before[name], after: plan[name] }; });
        const written = [];
        try {
            for (const name of changedNames) {
                if (!writeField(name, plan[name])) throw new Error(`${name} control rejected the write`);
                written.push(name);
            }
            await new Promise(function (resolve) { window.setTimeout(resolve, 50); });
            const verified = txt2imgStateSnapshot();
            if (!verified.ok) throw new Error(verified.error);
            const mismatch = changedNames.find(function (name) { return !sameValue(verified.state[name], plan[name]); });
            if (mismatch) throw new Error(`${mismatch} failed post-write verification`);
            tools.assistantState.txt2imgStateRead = { state_hash: verified.state_hash, state: verified.state, at: Date.now() };
            return { ok: true, target: "txt2img", changed: true, changes: audit, state_hash: verified.state_hash };
        } catch (error) {
            const rollbackOk = rollbackFields(before, written);
            return { ok: false, target: "txt2img", error: String(error?.message || error), rolled_back: rollbackOk, changes: audit };
        }
    }

    const previousExecute = tools.executeAssistantTool;
    async function executeAssistantTool(tool, signal) {
        const name = tool.tool || tool.name;
        if (name === "read_txt2img_state") return readTxt2ImgStateTool(tool.arguments || {});
        if (name === "apply_txt2img_patch") return await applyTxt2ImgPatchTool(tool.arguments || {});
        return await previousExecute(tool, signal);
    }

    Object.assign(tools, {
        YOLO_TOOL_NAMES,
        isYoloMode,
        isYoloTool,
        txt2imgStateSnapshot,
        readTxt2ImgStateTool,
        applyTxt2ImgPatchTool,
        executeAssistantTool
    });
})();
