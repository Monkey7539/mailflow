export function getContextMenuPolicy(variant = 'inbox') {
  const gtdSidebar = variant === 'gtdSidebar';
  // The conversation pane has no list row behind it, so there is nothing to select.
  const conversation = variant === 'conversation';
  return {
    select: !gtdSidebar && !conversation,
    compose: true,
    archive: !gtdSidebar,
    snooze: !gtdSidebar,
    categorize: !gtdSidebar,
    done: gtdSidebar,
    rules: true,
    spam: !gtdSidebar,
    copy: true,
    viewHeaders: true,
    // A picker's back row returns to the menu. The conversation pane opens only its pickers and
    // handles only their choice, so there most of the menu's actions would do nothing.
    menu: !conversation,
  };
}

export function resolveContextMenuMessage(message, variant, resolveMessage) {
  if (variant !== 'gtdSidebar') return Promise.resolve(message);
  return resolveMessage(message.message_id || message.id, message.account_id);
}
