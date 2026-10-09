import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CheckIcon } from '@primer/octicons-react';

export interface ToastOptions {
  /** Offers Undo; called when the person presses it. Only for actions that can really be undone. */
  undo?: () => void;
  /** Replaces the tick. */
  icon?: ReactNode;
}
type ShowToast = (message: string, options?: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);

const SHOW_MS = 8000;
/** After the pointer leaves a paused toast. */
const AFTER_HOVER_MS = 2500;

/**
 * One toast at a time, bottom right: it lasts 8 seconds, pauses while hovered and offers Undo when given one.
 * Always mounted, as a polite live region, so screen readers hear each new message.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{
    id: number;
    message: string;
    options: ToastOptions;
  } | null>(null);
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const seq = useRef(0);

  const hideIn = useCallback((ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(false), ms);
  }, []);

  const show = useCallback<ShowToast>(
    (message, options = {}) => {
      setToast({ id: ++seq.current, message, options });
      setShown(true);
      hideIn(SHOW_MS);
    },
    [hideIn]
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  const undo = () => {
    clearTimeout(timer.current);
    setShown(false);
    toast?.options.undo?.();
  };

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        className={shown ? 'toast show' : 'toast'}
        role="status"
        aria-live="polite"
        aria-hidden={shown ? undefined : true}
        onMouseEnter={() => clearTimeout(timer.current)}
        onMouseLeave={() => shown && hideIn(AFTER_HOVER_MS)}
      >
        {toast && (
          <>
            {toast.options.icon ?? <CheckIcon size={16} />}
            <span key={toast.id}>{toast.message}</span>
            {toast.options.undo && (
              <button
                className="btn small quiet"
                type="button"
                onClick={undo}
                tabIndex={shown ? 0 : -1}
              >
                Undo
              </button>
            )}
          </>
        )}
      </div>
    </ToastContext.Provider>
  );
}

/** `toast(message, { undo?, icon? })`. Needs a `<ToastProvider>` above (src/main.tsx mounts one). */
export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast must be used inside <ToastProvider>');
  return show;
}
