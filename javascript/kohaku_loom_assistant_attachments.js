(function () {
    const tools = window.kohakuLoom;
    if (!tools) return;

    const MAX_ATTACHMENTS = 6;
    const MAX_FILE_BYTES = 24 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 48 * 1024 * 1024;

    function normalizedAttachments(value) {
        if (!value) return [];
        return (Array.isArray(value) ? value : [value]).filter(function (item) {
            return item && item.dataUrl;
        });
    }

    function setAssistantAttachments(value) {
        tools.assistantState.attachments = normalizedAttachments(value).slice(0, MAX_ATTACHMENTS);
        renderAssistantAttachments();
    }

    function appendAssistantAttachments(value) {
        const current = normalizedAttachments(tools.assistantState.attachments);
        const incoming = normalizedAttachments(value);
        if (current.length + incoming.length > MAX_ATTACHMENTS) {
            throw new Error(`最多可附加 ${MAX_ATTACHMENTS} 张图片。`);
        }
        const total = current.concat(incoming).reduce(function (sum, item) { return sum + (Number(item.size) || 0); }, 0);
        if (total > MAX_TOTAL_BYTES) throw new Error("图片总大小不能超过 48 MB。");
        setAssistantAttachments(current.concat(incoming));
    }

    function renderAttachment(container, attachment, removable) {
        const media = document.createElement("div");
        media.className = "loom-assistant-user-attachment";
        const image = document.createElement("img");
        image.src = attachment.dataUrl;
        image.alt = attachment.name || "reference image";
        image.title = attachment.name || "reference image";
        media.appendChild(image);
        if (removable) {
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "loom-assistant-attachment-remove";
            remove.textContent = "×";
            remove.title = "移除";
            remove.setAttribute("aria-label", `移除 ${attachment.name || "图片"}`);
            remove.addEventListener("click", function () {
                const current = normalizedAttachments(tools.assistantState.attachments);
                setAssistantAttachments(current.filter(function (item) { return item !== attachment; }));
            });
            media.appendChild(remove);
        }
        container.appendChild(media);
    }

    function renderAssistantAttachments() {
        const holder = tools.assistantPanel()?.querySelector("#loom_assistant_attachment");
        if (!holder) return;
        const attachments = normalizedAttachments(tools.assistantState.attachments);
        holder.replaceChildren();
        holder.classList.toggle("loom-assistant-attachment-empty", !attachments.length);
        attachments.forEach(function (attachment) { renderAttachment(holder, attachment, true); });
    }

    function readAssistantImageFile(file) {
        return new Promise(function (resolve, reject) {
            if (!file) return reject(new Error("no file selected"));
            if (!String(file.type || "").startsWith("image/")) return reject(new Error("请选择图片文件。"));
            if (file.size > MAX_FILE_BYTES) return reject(new Error("单张图片不能超过 24 MB。"));
            const reader = new FileReader();
            reader.onload = function () {
                resolve({ name: file.name, dataUrl: String(reader.result || ""), size: Number(file.size) || 0 });
            };
            reader.onerror = function () { reject(new Error("读取图片失败。")); };
            reader.readAsDataURL(file);
        });
    }

    async function readAssistantImageFiles(files) {
        const list = Array.from(files || []);
        if (!list.length) return [];
        if (list.length > MAX_ATTACHMENTS) throw new Error(`一次最多选择 ${MAX_ATTACHMENTS} 张图片。`);
        if (list.reduce(function (sum, file) { return sum + (Number(file.size) || 0); }, 0) > MAX_TOTAL_BYTES) {
            throw new Error("图片总大小不能超过 48 MB。");
        }
        return await Promise.all(list.map(readAssistantImageFile));
    }

    function addAssistantUserMessage(text, attachments, inputText, forgeSnapshot) {
        const log = tools.assistantPanel()?.querySelector("#loom_assistant_messages");
        if (!log) return null;
        log.querySelector(".loom-assistant-empty")?.remove();
        const item = document.createElement("div");
        item.className = "loom-assistant-msg loom-assistant-user";
        item.dataset.loomRole = typeof tools.tr === "function" ? tools.tr("assistant.role.user") : "你";
        if (text) {
            const body = document.createElement("div");
            body.className = "loom-assistant-user-body";
            body.textContent = text;
            item.appendChild(body);
        }
        const media = normalizedAttachments(attachments);
        if (media.length) {
            const gallery = document.createElement("div");
            gallery.className = "loom-assistant-user-attachments";
            media.forEach(function (attachment) { renderAttachment(gallery, attachment, false); });
            item.appendChild(gallery);
        }
        const actions = document.createElement("div");
        actions.className = "loom-assistant-message-actions";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "loom-assistant-message-edit";
        const label = typeof tools.tr === "function" ? tools.tr("assistant.rewind") : "编辑并重新发送";
        edit.title = label;
        edit.setAttribute("aria-label", label);
        edit.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 20 4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16zM13.8 7.3l3 3"/></svg>';
        edit.addEventListener("click", function () {
            tools.restoreForgeUiState?.(forgeSnapshot);
            const input = tools.assistantPanel?.()?.querySelector("#loom_assistant_input");
            if (input && (inputText || text)) {
                input.value = inputText || text;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.focus();
            }
            setAssistantAttachments(media);
        });
        actions.appendChild(edit);
        item.appendChild(actions);
        log.appendChild(item);
        log.scrollTop = log.scrollHeight;
        return item;
    }

    Object.assign(tools, {
        MAX_ASSISTANT_ATTACHMENTS: MAX_ATTACHMENTS,
        normalizedAssistantAttachments: normalizedAttachments,
        setAssistantAttachments,
        appendAssistantAttachments,
        renderAssistantAttachments,
        readAssistantImageFile,
        readAssistantImageFiles,
        addAssistantUserMessage
    });
})();
