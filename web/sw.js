"use strict";
// Workaround to tell TypeScript about the correct type of a ServiceWorker.
const sw = self;
// There can be multiple clients (pages) receiving files, so they generate an id
// and here we store info assosiated with each transfer.
const streams = new Map();
class Stream {
    constructor(name, size, filetype) {
        this.offset = 0;
        this.name = name;
        this.size = size;
        this.filetype = filetype;
        this.stream = new ReadableStream(this);
    }
    start(controller) {
        this.controller = controller;
    }
    cancel(reason) {
        console.warn("stream cancelled", reason);
    }
}
function waitForMetadata(id) {
    return new Promise((resolve, reject) => {
        streams.set(id, { resolve, reject });
    });
}
function signalMetadataReady(id, s) {
    if (streams.has(id)) {
        streams.get(id).resolve(s);
    }
}
sw.addEventListener("message", (e) => {
    const msg = e.data;
    const id = msg.id;
    if (msg.type === "metadata") {
        const s = new Stream(msg.name, msg.size, msg.filetype);
        // Resolve promise if GET request arrived first.
        signalMetadataReady(id, s);
        streams.set(id, s);
    }
    else {
        const streamInfo = streams.get(id);
        if (msg.type === "data") {
            if (msg.offset !== streamInfo.offset) {
                console.warn(`aborting ${id}: got data out of order`);
                // TODO abort fetch response
                streams.delete(id);
                return;
            }
            streamInfo.controller.enqueue(new Uint8Array(msg.data));
            streamInfo.offset += msg.data.byteLength;
        }
        else if (msg.type === "end") {
            streamInfo.controller.close();
            // Synchronize with fetch handler to clean up properly.
            if (streamInfo.requestHandled) {
                streams.delete(id);
            }
            else {
                streamInfo.streamHandled = true;
            }
        }
        else if (msg.type === "error") {
            streamInfo.controller.error(msg.error);
        }
    }
});
function encodeFilename(filename) {
    return encodeURIComponent(filename).replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\(/g, "%29").replace(/\*/g, "%2A");
}
async function streamDownload(id) {
    // Request may arrive before metadata.
    const s = streams.get(id) || (await waitForMetadata(id));
    // Synchronize with message handler end to clean up properly.
    if (s.streamHandled) {
        streams.delete(id);
    }
    else {
        s.requestHandled = true;
    }
    const { size, name, filetype, stream } = s;
    console.log(`downloading ${name} (${id})`);
    return new Response(stream, {
        headers: {
            "Content-Type": filetype,
            "Content-Length": size,
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeFilename(name)}`,
        },
    });
}
async function streamUpload(e) {
    if (!e.clientId) {
        return new Response("no client id", { "status": 500 });
    }
    const client = await sw.clients.get(e.clientId);
    if (!client) {
        return new Response("no client", { "status": 500 });
    }
    const contentLength = e.request.headers.get("content-length");
    const contentType = e.request.headers.get("content-type");
    const form = await e.request.formData();
    const title = form.get("title");
    if (!title) {
        return new Response("no title", { "status": 500 });
    }
    let body;
    if (e.request.body) {
        body = e.request.body;
    }
    else {
        return new Response("no body", { "status": 500 });
    }
    console.log(`uploading ${title}`);
    // ReadableStream is transferable on Chrome at the time of writing. Since Share
    // Target also only works on Chome, we can use this and avoid the complexity of
    // chunking over postMessage (like we do with downloads) or having to read the
    // whole file into memory.
    // TypeScript doesn't know that ReadableStream is transferable, hence body as
    // any.
    client.postMessage({
        name: title,
        size: contentLength,
        type: contentType,
        stream: body,
    }, [body]);
    // TODO wait for confirmation that file was successfully sent before
    // responding?
    return new Response("ok");
}
sw.addEventListener("fetch", (e) => {
    const PREFIX = "/_";
    const url = new URL(e.request.url);
    // Stream download from WebRTC DataChannel.
    if (url.pathname.startsWith(`${PREFIX}/`) && e.request.method === "GET") {
        const id = url.pathname.substring(`${PREFIX}/`.length);
        e.respondWith(streamDownload(id));
        return;
    }
    // Stream upload to WebRTC DataChannel, triggered by Share Target API.
    if (url.pathname.startsWith(`${PREFIX}/`) && e.request.method === "POST") {
        e.respondWith(streamUpload(e));
        return;
    }
    // Default to passthrough.
    e.respondWith(fetch(e.request));
});
