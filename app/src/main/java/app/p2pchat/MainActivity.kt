package app.p2pchat

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val engine = (application as App).engine
        setContent { MaterialTheme { Surface(Modifier.fillMaxSize()) { Root(engine) } } }
    }
}

@Composable
fun Root(e: ChatEngine) {
    val me by e.identity.collectAsState()
    var current by remember { mutableStateOf<Contact?>(null) }
    val peer = current
    when {
        me == null -> RegisterScreen(e)
        peer == null -> HomeScreen(e) { current = it }
        else -> {
            BackHandler { current = null }
            ChatScreen(e, peer) { current = null }
        }
    }
}

@Composable
fun RegisterScreen(e: ChatEngine) {
    var name by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Column(
        Modifier.fillMaxSize().systemBarsPadding().padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Choisis ton nom d'utilisateur", style = MaterialTheme.typography.titleLarge)
        OutlinedTextField(
            name, { name = it.lowercase() },
            Modifier.fillMaxWidth().padding(vertical = 12.dp),
            singleLine = true, label = { Text("a-z, 0-9, _ (3 à 20)") },
        )
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            enabled = !busy && name.length >= 3,
            onClick = {
                busy = true; error = null
                scope.launch {
                    runCatching { e.register(name) }.onFailure { error = it.message }
                    busy = false
                }
            },
        ) { Text("Créer mon compte") }
    }
}

@Composable
fun HomeScreen(e: ChatEngine, onOpen: (Contact) -> Unit) {
    val contacts by e.contacts.collectAsState(emptyList())
    var name by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().systemBarsPadding().padding(16.dp)) {
        Text("Mes contacts", style = MaterialTheme.typography.titleLarge)
        Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                name, { name = it.lowercase() }, Modifier.weight(1f),
                singleLine = true, label = { Text("Ajouter un utilisateur") },
            )
            Spacer(Modifier.width(8.dp))
            Button(onClick = {
                error = null
                scope.launch {
                    runCatching { e.addContact(name) }
                        .onSuccess { name = ""; onOpen(it) }
                        .onFailure { error = it.message }
                }
            }) { Text("OK") }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        LazyColumn {
            items(contacts, key = { it.id }) { c ->
                Text(
                    c.username,
                    Modifier.fillMaxWidth().clickable { onOpen(c) }.padding(vertical = 14.dp),
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
        }
    }
}

@Composable
fun ChatScreen(e: ChatEngine, peer: Contact, onBack: () -> Unit) {
    val flow = remember(peer.id) { e.messages(peer.id) }
    val msgs by flow.collectAsState(emptyList())
    var text by remember { mutableStateOf("") }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    LaunchedEffect(peer.id) { e.open(peer.id) }
    LaunchedEffect(msgs.size) { if (msgs.isNotEmpty()) listState.animateScrollToItem(msgs.lastIndex) }

    Column(Modifier.fillMaxSize().systemBarsPadding().imePadding()) {
        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("←") }
            Text(peer.username, style = MaterialTheme.typography.titleMedium)
        }
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
            state = listState,
        ) {
            items(msgs, key = { it.id }) { m ->
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 3.dp),
                    horizontalArrangement = if (m.outgoing) Arrangement.End else Arrangement.Start,
                ) {
                    Surface(
                        shape = MaterialTheme.shapes.medium,
                        color = if (m.outgoing) MaterialTheme.colorScheme.primaryContainer
                        else MaterialTheme.colorScheme.surfaceVariant,
                    ) {
                        Text(m.text + (if (m.outgoing && !m.sent) "  ⏳" else ""), Modifier.padding(10.dp))
                    }
                }
            }
        }
        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(text, { text = it }, Modifier.weight(1f), placeholder = { Text("Message") })
            Spacer(Modifier.width(8.dp))
            Button(
                enabled = text.isNotBlank(),
                onClick = { val t = text.trim(); text = ""; scope.launch { e.send(peer.id, t) } },
            ) { Text("Envoyer") }
        }
    }
}
