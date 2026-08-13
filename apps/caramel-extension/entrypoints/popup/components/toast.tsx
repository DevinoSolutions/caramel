import {
    createContext,
    useCallback,
    useContext,
    useRef,
    useState,
    type ReactNode,
} from 'react'

/**
 * Popup toasts (P2 React successor to popup.js showCopyToast): appended to an
 * aria-live container, start fading at 2000ms, removed when the fade-out
 * animation ends — same classes, same timing, same container id.
 */

interface ToastEntry {
    id: number
    message: string
    fading: boolean
}

const ToastContext = createContext<(message: string) => void>(() => {})

export const useToast = () => useContext(ToastContext)

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<ToastEntry[]>([])
    const nextId = useRef(0)

    const show = useCallback((message: string) => {
        nextId.current += 1
        const id = nextId.current
        setToasts(current => [...current, { id, message, fading: false }])
        setTimeout(() => {
            setToasts(current =>
                current.map(t => (t.id === id ? { ...t, fading: true } : t)),
            )
        }, 2000)
    }, [])

    return (
        <ToastContext.Provider value={show}>
            {children}
            <div
                id="toastContainer"
                className="copy-toast-container"
                aria-live="polite"
            >
                {toasts.map(t => (
                    <div
                        key={t.id}
                        className={
                            t.fading ? 'copy-toast fade-out' : 'copy-toast'
                        }
                        // Entry animations also end — only the fade-out's end
                        // removes the toast, so the handler exists only then.
                        onAnimationEnd={
                            t.fading
                                ? () =>
                                      setToasts(current =>
                                          current.filter(x => x.id !== t.id),
                                      )
                                : undefined
                        }
                    >
                        {t.message}
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    )
}
