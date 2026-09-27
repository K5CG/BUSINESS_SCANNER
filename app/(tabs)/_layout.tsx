import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useUiPalette } from '../../lib/ui-theme';

export default function TabLayout() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const palette = useUiPalette();
  const topInset = Platform.OS === 'android' ? Math.max(insets.top, 28) : insets.top;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: palette.primary,
        tabBarInactiveTintColor: palette.textSecondary,
        tabBarStyle: {
          backgroundColor: palette.surface,
          borderTopColor: palette.border,
        },
        headerTintColor: palette.primary,
        headerTitleStyle: { color: palette.textPrimary },
        headerStyle: { backgroundColor: palette.surface },
        sceneStyle: { backgroundColor: palette.background },
        ...(Platform.OS === 'android' && { headerStatusBarHeight: topInset }),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('home'),
          headerShown: false,
          tabBarAccessibilityLabel: t('home'),
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'home' : 'home-outline'} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: t('contacts'),
          tabBarAccessibilityLabel: t('contacts'),
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'people' : 'people-outline'} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="documents"
        options={{
          title: t('documents'),
          tabBarAccessibilityLabel: t('documents'),
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'documents' : 'documents-outline'} color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
