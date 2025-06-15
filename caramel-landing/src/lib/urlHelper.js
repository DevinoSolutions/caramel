export const isValidUrl = (str) => {
    try {
        const raw = str.trim();
        const url = /^(https?:)?\/\//i.test(raw)
            ? new URL(raw)
            : new URL(`https://${raw}`);
        return url.hostname.includes("."); // must have a dot
    } catch (e) {
        console.log(e)
        return false;
    }
};