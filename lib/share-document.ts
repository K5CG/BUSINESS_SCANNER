import { Alert, Share } from 'react-native';
import * as MailComposer from 'expo-mail-composer';
import * as Sharing from 'expo-sharing';
import { AnyDocument } from '../types';
import { exportToPlainText, getEmailSubject } from './export';
import { resolveImageUri } from './image-uri';
import { getDocumentById } from './storage';

export type EmailShareMode = 'text' | 'photos' | 'both';

function getAttachments(document: AnyDocument): string[] {
  return document.images.filter(Boolean).map(resolveImageUri);
}

async function resolveDocumentForEmail(document: AnyDocument): Promise<AnyDocument> {
  const fromDb = document.id ? await getDocumentById(document.id) : null;
  const doc = fromDb ?? document;

  if (!doc.rawText?.trim() && document.rawText?.trim()) {
    return { ...doc, rawText: document.rawText.trim() };
  }

  return doc;
}

function formatEmailBody(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

export async function shareDocumentByEmail(
  document: AnyDocument,
  mode: EmailShareMode,
  emailNotes?: string
): Promise<void> {
  const doc = await resolveDocumentForEmail(document);

  const subject = getEmailSubject(doc);
  const body = formatEmailBody(exportToPlainText(doc, { emailNotes }));
  const attachments = mode === 'text' ? [] : getAttachments(doc);

  if (mode !== 'text' && attachments.length === 0) {
    Alert.alert('Attenzione', 'Nessuna foto disponibile per questo documento.');
    if (mode === 'photos') return;
  }

  const mailAvailable = await MailComposer.isAvailableAsync();

  if (mailAvailable) {
    await MailComposer.composeAsync({
      subject,
      body,
      attachments,
    });
    return;
  }

  if (mode === 'text' || mode === 'both') {
    await Share.share({ message: body, title: subject });
  }

  if ((mode === 'photos' || mode === 'both') && attachments.length > 0) {
    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
      for (const uri of attachments) {
        await Sharing.shareAsync(uri, { dialogTitle: subject });
      }
    } else {
      Alert.alert(
        'Email non disponibile',
        "Installa un'app email (es. Gmail) per inviare foto e testo insieme."
      );
    }
  } else if (!mailAvailable && mode === 'photos') {
    Alert.alert(
      'Email non disponibile',
      "Installa un'app email (es. Gmail) per inviare le foto."
    );
  }
}
