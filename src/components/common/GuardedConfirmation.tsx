import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import type { ConfirmationGuard } from '@/stores/useNotificationStore';
import { guardPhraseMatches, holdProgress, isHoldKey } from './guardedConfirmationLogic';
import styles from './GuardedConfirmation.module.scss';

interface GuardedConfirmationProps {
  message: ReactNode;
  guard: ConfirmationGuard;
  isLoading: boolean;
  cancelText?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

type Step = 'review' | 'confirm';

/**
 * Two-step confirmation for actions that spend something scarce:
 * 1. review the account, what is left and any reason not to do it now;
 * 2. type a word, then press and hold the final button.
 * A single click or a stray Enter can never reach the action.
 */
export function GuardedConfirmation({
  message,
  guard,
  isLoading,
  cancelText,
  onCancel,
  onConfirm,
}: GuardedConfirmationProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('review');
  const [typed, setTyped] = useState('');
  const [progress, setProgress] = useState(0);
  const [fired, setFired] = useState(false);
  const holdStart = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const firedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const unlocked = guardPhraseMatches(typed, guard.phrase);
  const holdSeconds = Math.round((guard.holdMs / 1000) * 10) / 10;

  const stopHold = useCallback(() => {
    holdStart.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (!firedRef.current) setProgress(0);
  }, []);

  useEffect(() => stopHold, [stopHold]);

  useEffect(() => {
    if (step === 'confirm') inputRef.current?.focus();
  }, [step]);

  const startHold = () => {
    if (!unlocked || isLoading || firedRef.current || holdStart.current !== null) return;
    const begin = performance.now();
    holdStart.current = begin;
    const advance = () => {
      if (holdStart.current !== begin) return;
      const value = holdProgress(performance.now() - begin, guard.holdMs);
      setProgress(value);
      if (value < 1) {
        frame.current = requestAnimationFrame(advance);
        return;
      }
      holdStart.current = null;
      frame.current = null;
      firedRef.current = true;
      setFired(true);
      onConfirm();
    };
    frame.current = requestAnimationFrame(advance);
  };

  const handleTyped = (value: string) => {
    setTyped(value);
    if (!guardPhraseMatches(value, guard.phrase)) stopHold();
  };

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    startHold();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!isHoldKey(event.key)) return;
    // Stop the browser from turning Enter/Space into a click; only a full hold counts.
    event.preventDefault();
    if (!event.repeat) startHold();
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (isHoldKey(event.key)) stopHold();
  };

  const holding = progress > 0 && !fired;

  if (step === 'review') {
    return (
      <div className={styles.guard}>
        <p className={styles.step}>{t('reset_guard.step_review')}</p>
        {typeof message === 'string' ? <p className={styles.message}>{message}</p> : message}
        {guard.facts.length > 0 && (
          <dl className={styles.facts}>
            {guard.facts.map((fact) => (
              <div key={fact.label} className={styles.fact}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {guard.warnings.length > 0 && (
          <div role="note" className={styles.warnings}>
            <p className={styles.warningsTitle}>{t('reset_guard.warnings_title')}</p>
            <ul>
              {guard.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
        <div className={styles.actions}>
          <Button variant="ghost" onClick={onCancel}>
            {cancelText || t('common.cancel')}
          </Button>
          <Button variant="secondary" onClick={() => setStep('confirm')}>
            {t('reset_guard.continue')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.guard}>
      <p className={styles.step}>{t('reset_guard.step_confirm')}</p>
      <p className={styles.message}>{guard.finalNote}</p>
      <div className="form-group">
        <label htmlFor={inputId}>{t('reset_guard.type_label', { phrase: guard.phrase })}</label>
        <input
          id={inputId}
          ref={inputRef}
          className="input"
          value={typed}
          onChange={(event) => handleTyped(event.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          disabled={isLoading || fired}
        />
      </div>
      <p id={hintId} className={styles.hint} aria-live="polite">
        {fired
          ? t('reset_guard.working')
          : holding
            ? t('reset_guard.holding')
            : unlocked
              ? t('reset_guard.hold_hint', { seconds: holdSeconds })
              : t('reset_guard.locked_hint', { phrase: guard.phrase })}
      </p>
      <div className={styles.actions}>
        <Button variant="ghost" onClick={() => setStep('review')} disabled={isLoading || fired}>
          {t('reset_guard.back')}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={isLoading}>
          {cancelText || t('common.cancel')}
        </Button>
        <Button
          variant="danger"
          className={styles.holdButton}
          disabled={!unlocked || isLoading || fired}
          loading={isLoading}
          aria-describedby={hintId}
          onPointerDown={handlePointerDown}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onBlur={stopHold}
          onContextMenu={(event) => event.preventDefault()}
        >
          <span
            className={styles.holdFill}
            style={{ transform: `scaleX(${progress})` }}
            aria-hidden="true"
          />
          <span className={styles.holdLabel}>{guard.holdLabel}</span>
        </Button>
      </div>
    </div>
  );
}
