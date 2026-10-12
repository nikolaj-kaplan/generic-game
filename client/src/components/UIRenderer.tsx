import { useEffect, useRef, useState } from 'react';
import { UIComponent } from '../types';
import { useGame } from '../context/GameContext';

interface UIRendererProps {
  components: UIComponent[];
}

/**
 * Top-level renderer. Maintains a shared input-values map so that standalone
 * `input` components and standalone `button` components can work together even
 * when the LLM doesn't wrap them in a `form`.
 */
export default function UIRenderer({ components }: UIRendererProps) {
  const { send, currentTurn, expiredTimers } = useGame();
  // Shared state for standalone (top-level) inputs
  const [topInputValues, setTopInputValues] = useState<Record<string, string>>({});
  // Tracks which multiple_choice fieldIds have been submitted this screen
  const [submittedChoices, setSubmittedChoices] = useState<Record<string, string>>({});
  // One response per screen: everything is disabled after the first submit
  const [locked, setLocked] = useState(false);

  // Reset all interaction state whenever the UI changes (new screen from LLM)
  const prevComponents = useRef(components);
  useEffect(() => {
    if (prevComponents.current !== components) {
      setTopInputValues({});
      setSubmittedChoices({});
      setLocked(false);
      prevComponents.current = components;
    }
  }, [components]);

  const turn = currentTurn ?? undefined;

  // When this screen's countdown reaches zero the turn is over: lock the inputs.
  const countdown = components.find((c): c is UIComponent & { type: 'countdown' } => c.type === 'countdown');
  const [timeUp, setTimeUp] = useState(false);
  useEffect(() => {
    if (!countdown) return;
    if (expiredTimers.has(countdown.timerId)) {
      setTimeUp(true);
      return;
    }
    if (!countdown.endsAt) return;
    const check = () => setTimeUp(Date.now() >= countdown.endsAt!);
    check();
    const id = setInterval(check, 250);
    return () => clearInterval(id);
  }, [countdown, expiredTimers]);
  const inputsLocked = locked || timeUp;

  function handleTopInputChange(fieldId: string, value: string) {
    setTopInputValues((prev) => ({ ...prev, [fieldId]: value }));
  }

  function handleTopButtonClick(actionId: string) {
    if (locked || timeUp) return;
    setLocked(true);
    if (Object.keys(topInputValues).length > 0) {
      // Treat as a form submission so the server carries the input values
      send({ type: 'form_submit', formId: actionId, values: topInputValues, turn });
    } else {
      send({ type: 'action', actionId, turn });
    }
  }

  function handleChoiceSubmit(fieldId: string, option: string) {
    if (locked || timeUp || submittedChoices[fieldId]) return;
    setLocked(true);
    setSubmittedChoices((prev) => ({ ...prev, [fieldId]: option }));
    send({ type: 'form_submit', formId: fieldId, values: { [fieldId]: option }, turn });
  }

  function handleFormSubmit(formId: string, values: Record<string, string>) {
    if (locked || timeUp) return;
    setLocked(true);
    send({ type: 'form_submit', formId, values, turn });
  }

  return (
    <div className="ui-renderer">
      {timeUp && !locked && <p className="time-up">⏰ Time's up!</p>}
      {components.map((comp, i) => (
        <UIComponentNode
          key={i}
          component={comp}
          locked={inputsLocked}
          topInputValues={topInputValues}
          onTopInputChange={handleTopInputChange}
          onTopButtonClick={handleTopButtonClick}
          submittedChoices={submittedChoices}
          onChoiceSubmit={handleChoiceSubmit}
          onFormSubmit={handleFormSubmit}
        />
      ))}
    </div>
  );
}

interface NodeProps {
  component: UIComponent;
  locked: boolean;
  topInputValues: Record<string, string>;
  onTopInputChange: (fieldId: string, value: string) => void;
  onTopButtonClick: (actionId: string) => void;
  submittedChoices: Record<string, string>;
  onChoiceSubmit: (fieldId: string, option: string) => void;
  onFormSubmit: (formId: string, values: Record<string, string>) => void;
}

function UIComponentNode({ component: comp, locked, topInputValues, onTopInputChange, onTopButtonClick, submittedChoices, onChoiceSubmit, onFormSubmit }: NodeProps) {
  switch (comp.type) {
    case 'text':
      return <TextComponent content={comp.content} style={comp.style} />;

    case 'input':
      // Standalone input — render it and tie into the shared top-level values map
      return (
        <label className="field">
          {comp.label && <span className="field__label">{comp.label}</span>}
          {comp.multiline ? (
            <textarea
              className="field__input"
              placeholder={comp.placeholder}
              maxLength={comp.maxLength}
              value={topInputValues[comp.fieldId] ?? ''}
              onChange={(e) => onTopInputChange(comp.fieldId, e.target.value)}
              disabled={locked}
              rows={3}
              autoFocus
            />
          ) : (
            <input
              className="field__input"
              type="text"
              placeholder={comp.placeholder}
              maxLength={comp.maxLength}
              value={topInputValues[comp.fieldId] ?? ''}
              onChange={(e) => onTopInputChange(comp.fieldId, e.target.value)}
              onKeyDown={(e) => {
                // Enter presses the Submit button (the engine adds one to text screens), or the only button
                if (e.key === 'Enter' && !locked) {
                  const buttons = document.querySelectorAll<HTMLButtonElement>('.ui-renderer > .btn');
                  const submit = document.querySelector<HTMLButtonElement>('.ui-renderer > .btn[data-action="submit"]');
                  if (submit) submit.click();
                  else if (buttons.length === 1) buttons[0].click();
                }
              }}
              disabled={locked}
              autoFocus
            />
          )}
        </label>
      );

    case 'button':
      return (
        <button
          className={`btn btn--${comp.style ?? 'primary'} btn--full`}
          data-action={comp.actionId}
          disabled={comp.disabled || locked}
          onClick={() => onTopButtonClick(comp.actionId)}
        >
          {comp.label}
        </button>
      );

    case 'multiple_choice':
      return <MultipleChoice comp={comp} selected={submittedChoices[comp.fieldId] ?? null} disabled={locked} onSelect={onChoiceSubmit} />;

    case 'countdown':
      // Once this player has answered, their timer is no longer relevant.
      return locked ? null : <Countdown comp={comp} />;

    case 'scoreboard':
      return <Scoreboard players={comp.players} />;

    case 'form':
      return <Form comp={comp} locked={locked} onSubmit={onFormSubmit} />;

    case 'list':
      return <ListComponent items={comp.items} ordered={comp.ordered} />;

    case 'divider':
      return <hr className="ui-divider" />;

    default:
      return null;
  }
}

// =============================================================================
// Text
// =============================================================================

function TextComponent({
  content,
  style,
}: {
  content: string;
  style?: UIComponent & { type: 'text' } extends { style?: infer S } ? S : never;
}) {
  const cls = style ? `ui-text ui-text--${style}` : 'ui-text';
  return (
    <p className={cls}>
      {content.split('\n').map((line, i, arr) => (
        <span key={i}>
          {line}
          {i < arr.length - 1 && <br />}
        </span>
      ))}
    </p>
  );
}

// =============================================================================
// Multiple Choice
// =============================================================================

function MultipleChoice({
  comp,
  selected,
  disabled,
  onSelect,
}: {
  comp: UIComponent & { type: 'multiple_choice' };
  selected: string | null;
  disabled: boolean;
  onSelect: (fieldId: string, option: string) => void;
}) {
  return (
    <div className="mc">
      <p className="mc__question">{comp.question}</p>
      <div className="mc__options">
        {comp.options.map((opt) => {
          let cls = 'mc__option';
          if (selected === opt) cls += ' mc__option--selected';
          else if (selected !== null || disabled) cls += ' mc__option--disabled';
          return (
            <button key={opt} className={cls} onClick={() => onSelect(comp.fieldId, opt)} disabled={selected !== null || disabled}>
              {opt}
            </button>
          );
        })}
      </div>
      {selected && <p className="mc__feedback text-muted">Answer submitted.</p>}
    </div>
  );
}

// =============================================================================
// Countdown
// =============================================================================

function Countdown({ comp }: { comp: UIComponent & { type: 'countdown' } }) {
  const { expiredTimers, isAiThinking } = useGame();
  // endsAt (set by the server) keeps the countdown right after a reconnect
  const secondsLeft = () =>
    comp.endsAt ? Math.max(0, Math.ceil((comp.endsAt - Date.now()) / 1000)) : comp.seconds;
  const [remaining, setRemaining] = useState(secondsLeft);
  const expired = expiredTimers.has(comp.timerId);

  useEffect(() => {
    setRemaining(secondsLeft());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comp.timerId, comp.endsAt]);

  useEffect(() => {
    // Frozen while the AI works on the next screen (the turn has already ended).
    if (expired || remaining <= 0 || isAiThinking) return;
    const id = setInterval(() => {
      setRemaining(comp.endsAt ? secondsLeft() : (prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired, remaining, comp.endsAt, isAiThinking]);

  // Once time is up the AI takes over; a frozen "0s" box only adds noise.
  if (expired || remaining <= 0) return null;

  const isUrgent = remaining <= 5;
  const fraction = Math.max(0, Math.min(1, remaining / comp.seconds));

  return (
    <div className={`countdown ${isUrgent ? 'countdown--urgent' : ''}`}>
      <span className="countdown__label">{comp.label ?? 'Time remaining'}</span>
      <span className="countdown__time">{remaining}s</span>
      <div className="countdown__bar" aria-hidden="true">
        <span style={{ transform: `scaleX(${fraction})` }} />
      </div>
    </div>
  );
}

// =============================================================================
// Scoreboard
// =============================================================================

function Scoreboard({ players }: { players: Array<{ id: string; name: string; score: number }> }) {
  const sorted = [...players].sort((a, b) => b.score - a.score);

  return (
    <div className="scoreboard">
      <p className="scoreboard__title">Scores</p>
      {sorted.map((p, i) => (
        <div key={p.id} className="scoreboard__row">
          <span className="scoreboard__rank">{i + 1}.</span>
          <span className="scoreboard__name">{p.name}</span>
          <span className="scoreboard__score">{p.score}</span>
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// Form
// =============================================================================

function Form({
  comp,
  locked,
  onSubmit,
}: {
  comp: UIComponent & { type: 'form' };
  locked: boolean;
  onSubmit: (formId: string, values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  function handleChange(fieldId: string, value: string) {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitted || locked) return;
    setSubmitted(true);
    onSubmit(comp.formId, values);
  }

  return (
    <form className="ui-form" onSubmit={handleSubmit}>
      {comp.fields.map((field, i) => (
        <FormField
          key={i}
          field={field}
          value={values[(field as { fieldId?: string }).fieldId ?? ''] ?? ''}
          onChange={handleChange}
          disabled={submitted || locked}
        />
      ))}
      <button
        className="btn btn--primary btn--full"
        type="submit"
        disabled={submitted || locked}
      >
        {comp.submitLabel ?? 'Submit'}
      </button>
      {submitted && <p className="text-muted text-center">Submitted.</p>}
    </form>
  );
}

function FormField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: UIComponent;
  value: string;
  onChange: (id: string, val: string) => void;
  disabled: boolean;
}) {
  if (field.type === 'input') {
    return (
      <label className="field">
        {field.label && <span className="field__label">{field.label}</span>}
        {field.multiline ? (
          <textarea
            className="field__input"
            placeholder={field.placeholder}
            maxLength={field.maxLength}
            value={value}
            onChange={(e) => onChange(field.fieldId, e.target.value)}
            disabled={disabled}
            rows={3}
          />
        ) : (
          <input
            className="field__input"
            type="text"
            placeholder={field.placeholder}
            maxLength={field.maxLength}
            value={value}
            onChange={(e) => onChange(field.fieldId, e.target.value)}
            disabled={disabled}
          />
        )}
      </label>
    );
  }

  if (field.type === 'text') {
    return <TextComponent content={field.content} style={field.style} />;
  }

  return null;
}

// =============================================================================
// List
// =============================================================================

function ListComponent({ items, ordered }: { items: string[]; ordered?: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className="ui-list">
      {items.map((item, i) => (
        <li key={i} className="ui-list__item">{item}</li>
      ))}
    </Tag>
  );
}
