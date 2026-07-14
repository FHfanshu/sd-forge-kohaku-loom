(function () {
    const tools = window.q3vlPromptTools;
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
        media.className = "q3vl-assistant-user-attachment";
        const image = document.createElement("img");
        image.src = attachment.dataUrl;
        image.alt = attachment.name || "reference image";
        image.title = attachment.name || "reference image";
        media.appendChild(image);
        if (removable) {
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "q3vl-assistant-attachment-remove";
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
        const holder = tools.assistantPanel()?.querySelector("#q3vl_assistant_attachment");
        if (!holder) return;
        const attachments = normalizedAttachments(tools.assistantState.attachments);
        holder.replaceChildren();
        holder.classList.toggle("q3vl-assistant-attachment-empty", !attachments.length);
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

    function addAssistantUserMessage(text, attachments) {
        const log = tools.assistantPanel()?.querySelector("#q3vl_assistant_messages");
        if (!log) return null;
        log.querySelector(".q3vl-assistant-empty")?.remove();
        const item = document.createElement("div");
        item.className = "q3vl-assistant-msg q3vl-assistant-user";
        item.dataset.q3vlRole = typeof tools.tr === "function" ? tools.tr("assistant.role.user") : "你";
        if (text) {
            const body = document.createElement("div");
            body.className = "q3vl-assistant-user-body";
            body.textContent = text;
            item.appendChild(body);
        }
        const media = normalizedAttachments(attachments);
        if (media.length) {
            const gallery = document.createElement("div");
            gallery.className = "q3vl-assistant-user-attachments";
            media.forEach(function (attachment) { renderAttachment(gallery, attachment, false); });
            item.appendChild(gallery);
        }
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
